import type { PoolClient } from 'pg';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction, withTransaction } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { withIdempotency, type IdempotentResult } from '../../shared/idempotency.js';
import type { AuthContext } from '../auth/auth.types.js';
import type { CheckinInput, CreateShiftSlotInput, ShiftPositionView } from './shift.types.js';
import { ensureMissedCheckinSearch } from './shift-search.service.js';

interface ListShiftFilters { from: Date; to: Date; storeId?: string | undefined }

interface PositionRow extends Omit<ShiftPositionView, 'nextAction' | 'applications' | 'changeRequests'> {
  applications: ShiftPositionView['applications'] | null;
  changeRequests: ShiftPositionView['changeRequests'] | null;
}

const positionSelect = `
  SELECT position.id, slot.id AS "slotId", slot.store_id AS "storeId", store.name AS "storeName",
         slot.label, slot.starts_at AS "startsAt", slot.ends_at AS "endsAt",
         slot.checkin_opens_at AS "checkinOpensAt", slot.checkin_deadline_at AS "checkinDeadlineAt",
         slot.checkin_radius_m AS "checkinRadiusM", slot.search_radius_m AS "searchRadiusM",
         slot.compensation_cents AS "compensationCents", slot.currency, slot.requirements,
         slot.auto_approve_substitutes AS "autoApproveSubstitutes",
         slot.confirmation_lead_minutes AS "confirmationLeadMinutes",
         slot.withdrawal_notice_minutes AS "withdrawalNoticeMinutes", slot.status AS "slotStatus",
         position.position_number AS "positionNumber", position.status,
         position.holder_courier_id AS "holderCourierId",
         CASE WHEN $2::text IN ('TENANT_MANAGER', 'STORE_OPERATOR') OR holder.user_id = $4
           THEN holder_user.name ELSE NULL END AS "holderCourierName",
         position.assigned_courier_id AS "assignedCourierId",
         CASE WHEN $2::text IN ('TENANT_MANAGER', 'STORE_OPERATOR') OR assigned.user_id = $4
           THEN assigned_user.name ELSE NULL END AS "assignedCourierName",
         position.checkin_at AS "checkinAt", position.checkin_distance_m AS "checkinDistanceM",
         position.checkout_at AS "checkoutAt",
         own_application.id AS "myApplicationId", own_application.status AS "myApplicationStatus",
         search.id AS "searchId", search.status AS "searchStatus",
         active_wave.wave_number AS "searchWaveNumber", active_wave.radius_m AS "searchWaveRadiusM",
         active_wave.closes_at AS "searchClosesAt", COALESCE(active_wave.candidate_count, 0) AS "searchCandidateCount",
         own_candidate.id AS "mySearchCandidateId",
         confirmation.status AS "confirmationStatus", confirmation.due_at AS "confirmationDueAt",
         pending_change.id AS "pendingChangeRequestId",
         CASE WHEN $2::text IN ('TENANT_MANAGER', 'STORE_OPERATOR') THEN COALESCE((
           SELECT json_agg(json_build_object(
             'id', request_item.id, 'requestType', request_item.request_type,
             'requesterCourierId', request_item.requester_courier_id, 'requesterCourierName', requester_user.name,
             'suggestedCourierId', request_item.suggested_courier_id, 'suggestedCourierName', suggested_user.name,
             'status', request_item.status, 'reason', request_item.reason, 'noticeMinutes', request_item.notice_minutes,
             'createdAt', request_item.created_at
           ) ORDER BY request_item.created_at DESC)
           FROM shift_change_requests request_item
           LEFT JOIN courier_profiles requester ON requester.id = request_item.requester_courier_id
           LEFT JOIN users requester_user ON requester_user.id = requester.user_id
           LEFT JOIN courier_profiles suggested ON suggested.id = request_item.suggested_courier_id
           LEFT JOIN users suggested_user ON suggested_user.id = suggested.user_id
           WHERE request_item.position_id = position.id
         ), '[]'::json) ELSE '[]'::json END AS "changeRequests",
         CASE WHEN $2::text IN ('TENANT_MANAGER', 'STORE_OPERATOR') THEN COALESCE((
           SELECT json_agg(json_build_object(
             'id', application.id, 'courierId', application.courier_profile_id,
             'courierName', applicant_user.name, 'status', application.status,
             'createdAt', application.created_at
           ) ORDER BY application.created_at)
           FROM shift_applications application
           JOIN courier_profiles applicant ON applicant.id = application.courier_profile_id
           JOIN users applicant_user ON applicant_user.id = applicant.user_id
           WHERE application.position_id = position.id
         ), '[]'::json) ELSE '[]'::json END AS applications
  FROM shift_positions position
  JOIN shift_slots slot ON slot.id = position.slot_id
  JOIN stores store ON store.id = slot.store_id
  LEFT JOIN courier_profiles holder ON holder.id = position.holder_courier_id
  LEFT JOIN users holder_user ON holder_user.id = holder.user_id
  LEFT JOIN courier_profiles assigned ON assigned.id = position.assigned_courier_id
  LEFT JOIN users assigned_user ON assigned_user.id = assigned.user_id
  LEFT JOIN courier_profiles own_profile ON own_profile.user_id = $4
  LEFT JOIN shift_applications own_application
    ON own_application.position_id = position.id AND own_application.courier_profile_id = own_profile.id
  LEFT JOIN shift_searches search ON search.position_id = position.id
  LEFT JOIN shift_search_waves active_wave ON active_wave.search_id = search.id AND active_wave.status = 'ACTIVE'
  LEFT JOIN shift_search_candidates own_candidate ON own_candidate.search_id = search.id
    AND own_candidate.courier_profile_id = own_profile.id AND own_candidate.status IN ('NOTIFIED', 'ACCEPTED')
  LEFT JOIN shift_confirmations confirmation ON confirmation.position_id = position.id
    AND confirmation.courier_profile_id = position.assigned_courier_id
  LEFT JOIN shift_change_requests pending_change ON pending_change.position_id = position.id
    AND pending_change.status = 'PENDING'`;

function canUseStore(auth: AuthContext, storeId: string): boolean {
  return auth.role === 'TENANT_MANAGER' || (auth.role === 'STORE_OPERATOR' && auth.storeIds.includes(storeId));
}

function withNextAction(row: PositionRow, auth: AuthContext): ShiftPositionView {
  let nextAction: ShiftPositionView['nextAction'] = null;
  if (auth.role === 'COURIER') {
    const own = row.assignedCourierId !== null && row.assignedCourierName !== null;
    const ownReservation = row.holderCourierId !== null && row.holderCourierName !== null;
    if (row.status === 'ACTIVE' && own) nextAction = 'CHECK_OUT';
    else if (row.pendingChangeRequestId && own) nextAction = 'AWAIT_APPROVAL';
    else if (row.status === 'FILLED' && own && row.confirmationStatus === 'PENDING') nextAction = 'CONFIRM';
    else if (row.status === 'FILLED' && own) nextAction = 'CHECK_IN';
    else if (row.myApplicationStatus === 'PENDING') nextAction = 'AWAIT_APPROVAL';
    else if (row.status === 'AVAILABLE' || (row.status === 'RESERVED' && ownReservation)) nextAction = 'ACCEPT';
  }
  return { ...row, applications: row.applications ?? [], changeRequests: row.changeRequests ?? [], nextAction };
}

async function ownCourierId(client: PoolClient, auth: AuthContext): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT profile.id FROM courier_profiles profile
     JOIN tenant_users membership ON membership.user_id = profile.user_id
     WHERE profile.user_id = $1 AND membership.tenant_id = $2
       AND membership.status = 'ACTIVE' AND profile.status = 'ACTIVE'`,
    [auth.userId, auth.tenantId],
  );
  const courier = result.rows[0];
  if (!courier) throw forbidden('Seu perfil de entregador não está ativo.');
  return courier.id;
}

async function lockCourier(client: PoolClient, courierId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shift:${courierId}`]);
}

async function appendEvent(
  client: PoolClient,
  auth: AuthContext,
  slotId: string,
  positionId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO shift_events (tenant_id, slot_id, position_id, event_type, actor_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [auth.tenantId, slotId, positionId, eventType, auth.userId, JSON.stringify(metadata)],
  );
}

async function publishEvent(
  client: PoolClient,
  auth: AuthContext,
  positionId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'shift_position', $2, $3, $4::jsonb)`,
    [auth.tenantId, positionId, eventType, JSON.stringify(payload)],
  );
}

async function hasOverlap(
  client: PoolClient,
  courierId: string,
  slotId: string,
  startsAt: Date | string,
  endsAt: Date | string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM shift_positions other_position
     JOIN shift_slots other_slot ON other_slot.id = other_position.slot_id
     WHERE other_position.assigned_courier_id = $1 AND other_position.slot_id <> $2
       AND other_position.status IN ('FILLED', 'ACTIVE')
       AND other_slot.starts_at < $4 AND other_slot.ends_at > $3
     LIMIT 1`,
    [courierId, slotId, startsAt, endsAt],
  );
  return Boolean(result.rowCount);
}

async function loadPosition(
  client: PoolClient,
  auth: AuthContext,
  positionId: string,
): Promise<ShiftPositionView> {
  const result = await client.query<PositionRow>(
    `${positionSelect} WHERE position.id = $1 AND ($3::uuid[] IS NULL OR true)`,
    [positionId, auth.role, auth.storeIds, auth.userId],
  );
  const row = result.rows[0];
  if (!row) throw notFound('Vaga de turno não encontrada.');
  return withNextAction(row, auth);
}

export async function listShiftPositions(
  database: Database,
  auth: AuthContext,
  filters: ListShiftFilters,
): Promise<{ data: ShiftPositionView[] }> {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query<PositionRow>(
      `${positionSelect}
       WHERE slot.starts_at < $6 AND slot.ends_at > $5
         AND ($7::uuid IS NULL OR slot.store_id = $7)
         AND (
           $2::text = 'TENANT_MANAGER'
           OR ($2::text = 'STORE_OPERATOR' AND slot.store_id = ANY($3::uuid[]))
           OR ($2::text = 'COURIER' AND (
             position.assigned_courier_id = own_profile.id
             OR position.holder_courier_id = own_profile.id
             OR own_application.id IS NOT NULL
             OR (position.status = 'AVAILABLE'
               AND (search.id IS NULL OR search.status <> 'SEARCHING' OR own_candidate.id IS NOT NULL)
               AND EXISTS (
               SELECT 1 FROM courier_store_links link
               WHERE link.tenant_id = $1 AND link.store_id = slot.store_id
                 AND link.courier_profile_id = own_profile.id AND link.status = 'ACTIVE'
             ))
           ))
         )
       ORDER BY slot.starts_at, store.name, position.position_number`,
      [auth.tenantId, auth.role, auth.storeIds, auth.userId, filters.from, filters.to, filters.storeId ?? null],
    );
    return { data: result.rows.map((row) => withNextAction(row, auth)) };
  });
}

export async function createShiftSlot(
  database: Database,
  auth: AuthContext,
  key: string,
  input: CreateShiftSlotInput,
  ip?: string,
): Promise<IdempotentResult<{ data: ShiftPositionView[] }>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, 'shift-slot.create', input, async () => {
      if (!canUseStore(auth, input.storeId)) throw forbidden('Você não administra esta loja.');
      const store = await client.query('SELECT 1 FROM stores WHERE id = $1 AND status = \'ACTIVE\'', [input.storeId]);
      if (!store.rowCount) throw notFound('Loja ativa não encontrada.');
      if (input.holderCourierIds.length > input.headcount) throw conflict('Há mais titulares do que vagas.');
      const uniqueHolders = [...new Set(input.holderCourierIds)];
      if (uniqueHolders.length !== input.holderCourierIds.length) throw conflict('Não repita entregadores titulares.');
      if (uniqueHolders.length) {
        const linked = await client.query(
          `SELECT courier_profile_id FROM courier_store_links
           WHERE tenant_id = $1 AND store_id = $2 AND status = 'ACTIVE'
             AND courier_profile_id = ANY($3::uuid[])`,
          [auth.tenantId, input.storeId, uniqueHolders],
        );
        if (linked.rowCount !== uniqueHolders.length) throw conflict('Todo titular deve possuir vínculo ativo com a loja.');
      }
      const checkinOpensAt = new Date(input.startsAt.getTime() - input.checkinOpenMinutes * 60_000);
      const checkinDeadlineAt = new Date(input.startsAt.getTime() + input.checkinToleranceMinutes * 60_000);
      const slotResult = await client.query<{ id: string }>(
        `INSERT INTO shift_slots
           (tenant_id, store_id, label, starts_at, ends_at, checkin_opens_at, checkin_deadline_at,
            checkin_radius_m, search_radius_m, compensation_cents, requirements,
            auto_approve_substitutes, confirmation_lead_minutes, withdrawal_notice_minutes,
            created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $15)
         RETURNING id`,
        [auth.tenantId, input.storeId, input.label, input.startsAt, input.endsAt,
          checkinOpensAt, checkinDeadlineAt, input.checkinRadiusM, input.searchRadiusM,
          input.compensationCents, JSON.stringify(input.requirements), input.autoApproveSubstitutes,
          input.confirmationLeadMinutes, input.withdrawalNoticeMinutes, auth.userId],
      );
      const slotId = slotResult.rows[0]!.id;
      const positionIds: string[] = [];
      for (let index = 0; index < input.headcount; index += 1) {
        const holderId = uniqueHolders[index] ?? null;
        const created = await client.query<{ id: string }>(
          `INSERT INTO shift_positions
             (tenant_id, slot_id, position_number, holder_courier_id, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
          [auth.tenantId, slotId, index + 1, holderId, holderId ? 'RESERVED' : 'AVAILABLE', auth.userId],
        );
        const positionId = created.rows[0]!.id;
        positionIds.push(positionId);
        await appendEvent(client, auth, slotId, positionId, holderId ? 'POSITION_RESERVED' : 'POSITION_AVAILABLE',
          holderId ? { holderCourierId: holderId } : {});
        if (!holderId) await publishEvent(client, auth, positionId, 'shift.available', { storeId: input.storeId });
      }
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'shift.slot.created',
        entityType: 'shift_slot', entityId: slotId,
        afterData: { ...input, startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString(), positionIds },
        ...(ip ? { ip } : {}),
      });
      const data: ShiftPositionView[] = [];
      for (const id of positionIds) data.push(await loadPosition(client, auth, id));
      return { body: { data }, statusCode: 201 };
    },
  ));
}

export async function acceptShiftPosition(
  database: Database,
  auth: AuthContext,
  key: string,
  positionId: string,
  ip?: string,
): Promise<IdempotentResult<ShiftPositionView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `shift-position.accept:${positionId}`, {}, async () => {
      const courierId = await ownCourierId(client, auth);
      await lockCourier(client, courierId);
      const result = await client.query<{
        id: string; slot_id: string; store_id: string; starts_at: Date; ends_at: Date;
        checkin_deadline_at: Date; auto_approve_substitutes: boolean; status: string;
        holder_courier_id: string | null; assigned_courier_id: string | null;
      }>(
        `SELECT position.id, position.slot_id, slot.store_id, slot.starts_at, slot.ends_at,
                slot.checkin_deadline_at, slot.auto_approve_substitutes, position.status,
                position.holder_courier_id, position.assigned_courier_id
         FROM shift_positions position JOIN shift_slots slot ON slot.id = position.slot_id
         WHERE position.id = $1 FOR UPDATE OF position`,
        [positionId],
      );
      const position = result.rows[0];
      if (!position) throw notFound('Vaga de turno não encontrada.');
      if (position.assigned_courier_id === courierId && ['FILLED', 'ACTIVE'].includes(position.status)) {
        return { body: await loadPosition(client, auth, positionId), statusCode: 200 };
      }
      const existing = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM shift_applications WHERE position_id = $1 AND courier_profile_id = $2`,
        [positionId, courierId],
      );
      if (existing.rows[0]?.status === 'PENDING') {
        return { body: await loadPosition(client, auth, positionId), statusCode: 202 };
      }
      if (!['AVAILABLE', 'RESERVED'].includes(position.status)) throw conflict('Esta vaga já foi preenchida.');
      if (new Date(position.checkin_deadline_at).getTime() < Date.now()) throw conflict('A janela de check-in desta vaga encerrou.');
      if (position.status === 'RESERVED' && position.holder_courier_id !== courierId) {
        throw forbidden('Esta vaga ainda está reservada ao titular.');
      }
      const link = await client.query(
        `SELECT 1 FROM courier_store_links WHERE tenant_id = $1 AND store_id = $2
           AND courier_profile_id = $3 AND status = 'ACTIVE'`,
        [auth.tenantId, position.store_id, courierId],
      );
      if (!link.rowCount) throw forbidden('Você não possui vínculo ativo com esta loja.');
      const activeSearch = await client.query<{ id: string; candidate_id: string | null; closes_at: Date | null }>(
        `SELECT search.id, candidate.id AS candidate_id, wave.closes_at
         FROM shift_searches search
         LEFT JOIN shift_search_candidates candidate ON candidate.search_id = search.id
           AND candidate.courier_profile_id = $2 AND candidate.status IN ('NOTIFIED', 'ACCEPTED')
         LEFT JOIN shift_search_waves wave ON wave.id = candidate.wave_id AND wave.status = 'ACTIVE'
         WHERE search.position_id = $1 AND search.status = 'SEARCHING'`, [positionId, courierId],
      );
      if (activeSearch.rows[0] && (!activeSearch.rows[0].candidate_id
          || !activeSearch.rows[0].closes_at || activeSearch.rows[0].closes_at.getTime() <= Date.now())) {
        throw forbidden('Aguarde a busca alcançar sua região ou uma nova onda ser aberta.');
      }
      if (await hasOverlap(client, courierId, position.slot_id, position.starts_at, position.ends_at)) {
        throw conflict('Você já está alocado em um turno que se sobrepõe a este horário.');
      }
      const immediatelyAccepted = position.status === 'RESERVED' || position.auto_approve_substitutes;
      const application = await client.query<{ id: string }>(
        `INSERT INTO shift_applications
           (tenant_id, position_id, courier_profile_id, status, resolved_by, resolved_at)
         VALUES ($1, $2, $3, $4::shift_application_status,
           CASE WHEN $4::text = 'ACCEPTED' THEN $5::uuid ELSE NULL::uuid END,
           CASE WHEN $4::text = 'ACCEPTED' THEN now() ELSE NULL END)
         ON CONFLICT (tenant_id, position_id, courier_profile_id) DO UPDATE
           SET status = EXCLUDED.status, resolved_by = EXCLUDED.resolved_by, resolved_at = EXCLUDED.resolved_at
         RETURNING id`,
        [auth.tenantId, positionId, courierId, immediatelyAccepted ? 'ACCEPTED' : 'PENDING', auth.userId],
      );
      if (immediatelyAccepted) {
        const updated = await client.query(
          `UPDATE shift_positions SET assigned_courier_id = $2, status = 'FILLED', updated_by = $3
           WHERE id = $1 AND status IN ('AVAILABLE', 'RESERVED')`,
          [positionId, courierId, auth.userId],
        );
        if (!updated.rowCount) throw conflict('Esta vaga foi preenchida por outra pessoa.');
        await client.query(
          `UPDATE shift_applications SET status = 'REJECTED', resolved_by = $2, resolved_at = now()
           WHERE position_id = $1 AND id <> $3 AND status = 'PENDING'`,
          [positionId, auth.userId, application.rows[0]!.id],
        );
        await appendEvent(client, auth, position.slot_id, positionId, 'POSITION_FILLED', { courierId });
        await publishEvent(client, auth, positionId, 'shift.filled', { courierId });
        await closeSearchWithWinner(client, positionId, courierId);
      } else {
        await appendEvent(client, auth, position.slot_id, positionId, 'APPLICATION_SUBMITTED', { courierId });
        await publishEvent(client, auth, positionId, 'shift.application.submitted', { storeId: position.store_id });
      }
      if (activeSearch.rows[0]?.candidate_id) {
        await client.query(
          `UPDATE shift_search_candidates SET status = 'ACCEPTED', responded_at = now()
           WHERE id = $1`, [activeSearch.rows[0].candidate_id],
        );
      }
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'shift.position.accepted',
        entityType: 'shift_position', entityId: positionId,
        afterData: { courierId, immediatelyAccepted }, ...(ip ? { ip } : {}),
      });
      return { body: await loadPosition(client, auth, positionId), statusCode: immediatelyAccepted ? 200 : 202 };
    },
  ));
}

export async function approveShiftApplication(
  database: Database,
  auth: AuthContext,
  key: string,
  applicationId: string,
  ip?: string,
): Promise<IdempotentResult<ShiftPositionView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `shift-application.approve:${applicationId}`, {}, async () => {
      const result = await client.query<{
        id: string; status: string; courier_profile_id: string; position_id: string; slot_id: string;
        store_id: string; position_status: string; starts_at: Date; ends_at: Date;
      }>(
        `SELECT application.id, application.status, application.courier_profile_id,
                application.position_id, position.slot_id, slot.store_id,
                position.status AS position_status, slot.starts_at, slot.ends_at
         FROM shift_applications application
         JOIN shift_positions position ON position.id = application.position_id
         JOIN shift_slots slot ON slot.id = position.slot_id
         WHERE application.id = $1 FOR UPDATE OF application, position`,
        [applicationId],
      );
      const application = result.rows[0];
      if (!application) throw notFound('Candidatura não encontrada.');
      if (!canUseStore(auth, application.store_id)) throw forbidden('Você não administra esta loja.');
      if (application.status === 'ACCEPTED') {
        return { body: await loadPosition(client, auth, application.position_id), statusCode: 200 };
      }
      if (application.status !== 'PENDING' || application.position_status !== 'AVAILABLE') {
        throw conflict('Esta candidatura não pode mais ser aprovada.');
      }
      await lockCourier(client, application.courier_profile_id);
      if (await hasOverlap(client, application.courier_profile_id, application.slot_id, application.starts_at, application.ends_at)) {
        throw conflict('O entregador já está alocado em um turno sobreposto.');
      }
      const updated = await client.query(
        `UPDATE shift_positions SET assigned_courier_id = $2, status = 'FILLED', updated_by = $3
         WHERE id = $1 AND status = 'AVAILABLE'`,
        [application.position_id, application.courier_profile_id, auth.userId],
      );
      if (!updated.rowCount) throw conflict('Esta vaga foi preenchida por outra aprovação.');
      await client.query(
        `UPDATE shift_applications
         SET status = CASE WHEN id = $2 THEN 'ACCEPTED'::shift_application_status ELSE 'REJECTED'::shift_application_status END,
             resolved_by = $3, resolved_at = now()
         WHERE position_id = $1 AND status = 'PENDING'`,
        [application.position_id, application.id, auth.userId],
      );
      await appendEvent(client, auth, application.slot_id, application.position_id,
        'APPLICATION_APPROVED', { courierId: application.courier_profile_id, applicationId });
      await publishEvent(client, auth, application.position_id, 'shift.filled', { courierId: application.courier_profile_id });
      await closeSearchWithWinner(client, application.position_id, application.courier_profile_id);
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'shift.application.approved',
        entityType: 'shift_application', entityId: applicationId,
        afterData: { positionId: application.position_id, courierId: application.courier_profile_id },
        ...(ip ? { ip } : {}),
      });
      return { body: await loadPosition(client, auth, application.position_id), statusCode: 200 };
    },
  ));
}

function distanceInMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRadians = (value: number) => value * Math.PI / 180;
  const earthRadius = 6_371_000;
  const latDelta = toRadians(lat2 - lat1);
  const lonDelta = toRadians(lon2 - lon1);
  const a = Math.sin(latDelta / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(lonDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function checkinShiftPosition(
  database: Database,
  auth: AuthContext,
  key: string,
  positionId: string,
  input: CheckinInput,
  ip?: string,
): Promise<IdempotentResult<ShiftPositionView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `shift-position.checkin:${positionId}`, input, async () => {
      const courierId = await ownCourierId(client, auth);
      await lockCourier(client, courierId);
      const result = await client.query<{
        slot_id: string; status: string; assigned_courier_id: string | null;
        checkin_opens_at: Date; checkin_deadline_at: Date; checkin_radius_m: number;
        store_latitude: number; store_longitude: number;
      }>(
        `SELECT position.slot_id, position.status, position.assigned_courier_id,
                slot.checkin_opens_at, slot.checkin_deadline_at, slot.checkin_radius_m,
                store.latitude AS store_latitude, store.longitude AS store_longitude
         FROM shift_positions position
         JOIN shift_slots slot ON slot.id = position.slot_id
         JOIN stores store ON store.id = slot.store_id
         WHERE position.id = $1 FOR UPDATE OF position`,
        [positionId],
      );
      const position = result.rows[0];
      if (!position || position.assigned_courier_id !== courierId) throw notFound('Turno atribuído não encontrado.');
      if (position.status === 'ACTIVE') return { body: await loadPosition(client, auth, positionId), statusCode: 200 };
      if (position.status !== 'FILLED') throw conflict('Este turno não está pronto para check-in.');
      const now = Date.now();
      if (now < new Date(position.checkin_opens_at).getTime()) throw conflict('A janela de check-in ainda não abriu.');
      if (now > new Date(position.checkin_deadline_at).getTime()) throw conflict('A janela de check-in encerrou.');
      if (input.accuracy > 100) throw conflict('A precisão do GPS deve ser de até 100 metros.');
      const distance = distanceInMeters(input.latitude, input.longitude,
        Number(position.store_latitude), Number(position.store_longitude));
      if (position.checkin_radius_m > 0 && distance > position.checkin_radius_m) {
        throw conflict(`Aproxime-se da loja para fazer check-in. Distância atual: ${Math.round(distance)} m.`);
      }
      const alreadyActive = await client.query(
        `SELECT 1 FROM shift_positions WHERE assigned_courier_id = $1 AND status = 'ACTIVE' AND id <> $2 LIMIT 1`,
        [courierId, positionId],
      );
      if (alreadyActive.rowCount) throw conflict('Você já possui outro turno ativo.');
      await client.query(
        `UPDATE shift_positions SET status = 'ACTIVE', checkin_at = now(), checkin_latitude = $2,
           checkin_longitude = $3, checkin_accuracy = $4, checkin_distance_m = $5, updated_by = $6
         WHERE id = $1`,
        [positionId, input.latitude, input.longitude, input.accuracy, distance, auth.userId],
      );
      await client.query(
        `UPDATE shift_confirmations SET status = 'CONFIRMED', responded_at = COALESCE(responded_at, now())
         WHERE position_id = $1 AND courier_profile_id = $2 AND status = 'PENDING'`, [positionId, courierId],
      );
      await client.query(
        `UPDATE shift_slots SET status = 'ACTIVE', updated_by = $2
         WHERE id = $1 AND status = 'SCHEDULED'`,
        [position.slot_id, auth.userId],
      );
      await appendEvent(client, auth, position.slot_id, positionId, 'CHECKIN_CONFIRMED',
        { courierId, distanceM: Math.round(distance), accuracy: input.accuracy });
      await publishEvent(client, auth, positionId, 'shift.checkin', { courierId });
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'shift.position.checkin',
        entityType: 'shift_position', entityId: positionId,
        afterData: { distanceM: Math.round(distance), accuracy: input.accuracy }, ...(ip ? { ip } : {}),
      });
      return { body: await loadPosition(client, auth, positionId), statusCode: 200 };
    },
  ));
}

export async function checkoutShiftPosition(
  database: Database,
  auth: AuthContext,
  key: string,
  positionId: string,
  ip?: string,
): Promise<IdempotentResult<ShiftPositionView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `shift-position.checkout:${positionId}`, {}, async () => {
      const courierId = await ownCourierId(client, auth);
      await lockCourier(client, courierId);
      const result = await client.query<{ slot_id: string; status: string; assigned_courier_id: string | null }>(
        `SELECT slot_id, status, assigned_courier_id FROM shift_positions WHERE id = $1 FOR UPDATE`,
        [positionId],
      );
      const position = result.rows[0];
      if (!position || position.assigned_courier_id !== courierId) throw notFound('Turno ativo não encontrado.');
      if (position.status === 'COMPLETED') return { body: await loadPosition(client, auth, positionId), statusCode: 200 };
      if (position.status !== 'ACTIVE') throw conflict('Este turno não está ativo.');
      const activeDelivery = await client.query(
        `SELECT 1 FROM deliveries WHERE courier_profile_id = $1
           AND status IN ('ASSIGNED', 'AWAITING_PICKUP', 'COLLECTED', 'IN_ROUTE', 'NEXT_STOP') LIMIT 1`,
        [courierId],
      );
      if (activeDelivery.rowCount) throw conflict('Conclua ou transfira as entregas ativas antes do check-out.');
      await client.query(
        `UPDATE shift_positions SET status = 'COMPLETED', checkout_at = now(), updated_by = $2 WHERE id = $1`,
        [positionId, auth.userId],
      );
      await client.query(
        `UPDATE shift_slots slot SET status = 'COMPLETED', updated_by = $2
         WHERE slot.id = $1 AND NOT EXISTS (
           SELECT 1 FROM shift_positions remaining WHERE remaining.slot_id = slot.id
             AND remaining.status NOT IN ('COMPLETED', 'CANCELLED')
         )`,
        [position.slot_id, auth.userId],
      );
      await appendEvent(client, auth, position.slot_id, positionId, 'CHECKOUT_CONFIRMED', { courierId });
      await publishEvent(client, auth, positionId, 'shift.checkout', { courierId });
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'shift.position.checkout',
        entityType: 'shift_position', entityId: positionId, ...(ip ? { ip } : {}),
      });
      return { body: await loadPosition(client, auth, positionId), statusCode: 200 };
    },
  ));
}

export async function releaseMissedCheckins(
  database: Database,
  limit = 100,
): Promise<{ released: number }> {
  return withTransaction(database, async (client) => {
    const result = await client.query<{
      id: string; tenant_id: string; slot_id: string; store_id: string; assigned_courier_id: string | null;
      holder_courier_id: string | null;
    }>(
      `SELECT position.id, position.tenant_id, position.slot_id, slot.store_id,
              position.assigned_courier_id, position.holder_courier_id
       FROM rastreia.shift_positions position
       JOIN rastreia.shift_slots slot ON slot.id = position.slot_id
       WHERE position.status IN ('FILLED', 'RESERVED')
         AND slot.checkin_deadline_at < now() AND slot.ends_at > now()
       ORDER BY slot.checkin_deadline_at
       FOR UPDATE OF position SKIP LOCKED LIMIT $1`,
      [limit],
    );
    for (const position of result.rows) {
      const missedCourierId = position.assigned_courier_id ?? position.holder_courier_id;
      await client.query(
        `UPDATE rastreia.shift_positions SET status = 'AVAILABLE', assigned_courier_id = NULL,
           updated_by = NULL WHERE id = $1`,
        [position.id],
      );
      await client.query(
        `INSERT INTO rastreia.shift_events
           (tenant_id, slot_id, position_id, event_type, metadata)
         VALUES ($1, $2, $3, 'CHECKIN_MISSED', $4::jsonb)`,
        [position.tenant_id, position.slot_id, position.id, JSON.stringify({ missedCourierId })],
      );
      await ensureMissedCheckinSearch(client, position);
    }
    return { released: result.rows.length };
  });
}

async function closeSearchWithWinner(client: PoolClient, positionId: string, courierId: string): Promise<void> {
  const search = await client.query<{ id: string }>(
    `UPDATE shift_searches SET status = 'FILLED', winner_courier_id = $2,
       completed_at = now() WHERE position_id = $1 AND status = 'SEARCHING' RETURNING id`,
    [positionId, courierId],
  );
  if (!search.rows[0]) return;
  await client.query(
    `UPDATE shift_search_waves SET status = 'CLOSED', closed_at = now()
     WHERE search_id = $1 AND status = 'ACTIVE'`, [search.rows[0].id],
  );
  await client.query(
    `UPDATE shift_search_candidates SET status = CASE WHEN courier_profile_id = $2
       THEN 'ACCEPTED'::shift_search_candidate_status ELSE 'LOST'::shift_search_candidate_status END,
       responded_at = COALESCE(responded_at, now()) WHERE search_id = $1`,
    [search.rows[0].id, courierId],
  );
}
