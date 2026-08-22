import type { PoolClient } from 'pg';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction, withTransaction } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { withIdempotency, type IdempotentResult } from '../../shared/idempotency.js';
import type { AuthContext } from '../auth/auth.types.js';
import { ensureMissedCheckinSearch } from './shift-search.service.js';

interface PositionContext {
  id: string; tenant_id: string; slot_id: string; store_id: string; starts_at: Date; ends_at: Date;
  status: string; assigned_courier_id: string | null; holder_courier_id: string | null;
  withdrawal_notice_minutes: number;
}

export interface ChangeRequestView {
  id: string; requestType: 'WITHDRAWAL' | 'SUBSTITUTION' | 'TRANSFER';
  requesterCourierId: string | null; requesterCourierName: string | null;
  suggestedCourierId: string | null; suggestedCourierName: string | null;
  status: string; reason: string; noticeMinutes: number; createdAt: string;
}

async function ownCourierId(client: PoolClient, auth: AuthContext): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT profile.id FROM courier_profiles profile
     JOIN tenant_users membership ON membership.user_id = profile.user_id
     WHERE profile.user_id = $1 AND membership.tenant_id = $2
       AND profile.status = 'ACTIVE' AND membership.status = 'ACTIVE'`, [auth.userId, auth.tenantId],
  );
  if (!result.rows[0]) throw forbidden('Seu perfil de entregador não está ativo.');
  return result.rows[0].id;
}

function canUseStore(auth: AuthContext, storeId: string): boolean {
  return auth.role === 'TENANT_MANAGER' || (auth.role === 'STORE_OPERATOR' && auth.storeIds.includes(storeId));
}

async function loadPosition(client: PoolClient, positionId: string): Promise<PositionContext> {
  const result = await client.query<PositionContext>(
    `SELECT position.id, position.tenant_id, position.slot_id, slot.store_id, slot.starts_at, slot.ends_at,
            position.status, position.assigned_courier_id, position.holder_courier_id,
            slot.withdrawal_notice_minutes
     FROM shift_positions position JOIN shift_slots slot ON slot.id = position.slot_id
     WHERE position.id = $1 FOR UPDATE OF position`, [positionId],
  );
  if (!result.rows[0]) throw notFound('Vaga de turno não encontrada.');
  return result.rows[0];
}

async function appendEvent(
  client: PoolClient, auth: AuthContext, position: PositionContext, eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO shift_events (tenant_id, slot_id, position_id, event_type, actor_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [auth.tenantId, position.slot_id, position.id, eventType, auth.userId, JSON.stringify(metadata)],
  );
}

async function publish(client: PoolClient, auth: AuthContext, positionId: string, eventType: string, payload = {}) {
  await client.query(
    `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'shift_position', $2, $3, $4::jsonb)`,
    [auth.tenantId, positionId, eventType, JSON.stringify(payload)],
  );
}

async function assertReplacement(
  client: PoolClient, position: PositionContext, courierId: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shift:${courierId}`]);
  const eligible = await client.query(
    `SELECT 1 FROM courier_store_links link JOIN courier_profiles profile ON profile.id = link.courier_profile_id
     WHERE link.tenant_id = $1 AND link.store_id = $2 AND link.courier_profile_id = $3
       AND link.status = 'ACTIVE' AND profile.status = 'ACTIVE'`,
    [position.tenant_id, position.store_id, courierId],
  );
  if (!eligible.rowCount) throw conflict('O substituto não possui vínculo ativo com esta loja.');
  const overlap = await client.query(
    `SELECT 1 FROM shift_positions occupied JOIN shift_slots slot ON slot.id = occupied.slot_id
     WHERE occupied.assigned_courier_id = $1 AND occupied.id <> $2
       AND occupied.status IN ('FILLED', 'ACTIVE') AND slot.starts_at < $4 AND slot.ends_at > $3 LIMIT 1`,
    [courierId, position.id, position.starts_at, position.ends_at],
  );
  if (overlap.rowCount) throw conflict('O substituto possui outro turno neste horário.');
}

async function createReplacementConfirmation(
  client: PoolClient, position: PositionContext, courierId: string,
): Promise<void> {
  const dueAt = new Date(Math.min(position.starts_at.getTime(), Date.now() + 60 * 60_000));
  await client.query(
    `INSERT INTO shift_confirmations (tenant_id, position_id, courier_profile_id, status, due_at)
     VALUES ($1, $2, $3, 'PENDING', $4)
     ON CONFLICT (tenant_id, position_id, courier_profile_id) DO UPDATE
       SET status = 'PENDING', due_at = EXCLUDED.due_at, requested_at = now(), responded_at = NULL`,
    [position.tenant_id, position.id, courierId, dueAt],
  );
}

async function releaseForCoverage(client: PoolClient, auth: AuthContext, position: PositionContext): Promise<void> {
  await client.query(
    `UPDATE shift_positions SET status = 'AVAILABLE', assigned_courier_id = NULL,
       holder_courier_id = NULL, updated_by = $2 WHERE id = $1`, [position.id, auth.userId],
  );
  await client.query(
    `UPDATE shift_confirmations SET status = 'EXPIRED', responded_at = COALESCE(responded_at, now())
     WHERE position_id = $1 AND status = 'PENDING'`, [position.id],
  );
  await ensureMissedCheckinSearch(client, { id: position.id, tenant_id: position.tenant_id });
}

export async function requestShiftWithdrawal(
  database: Database, auth: AuthContext, key: string, positionId: string,
  input: { reason: string; suggestedCourierId?: string | null | undefined }, ip?: string,
): Promise<IdempotentResult<ChangeRequestView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `shift-withdrawal:${positionId}`, input, async () => {
      const courierId = await ownCourierId(client, auth);
      const position = await loadPosition(client, positionId);
      if (!['RESERVED', 'FILLED'].includes(position.status)
          || (position.assigned_courier_id !== courierId && position.holder_courier_id !== courierId)) {
        throw forbidden('Você não é o responsável por esta vaga.');
      }
      if (input.suggestedCourierId === courierId) throw conflict('O substituto indicado deve ser outra pessoa.');
      if (input.suggestedCourierId) await assertReplacement(client, position, input.suggestedCourierId);
      const noticeMinutes = Math.max(0, Math.floor((position.starts_at.getTime() - Date.now()) / 60_000));
      const created = await client.query<ChangeRequestView>(
        `INSERT INTO shift_change_requests
           (tenant_id, position_id, request_type, requester_courier_id, suggested_courier_id,
            reason, notice_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, request_type AS "requestType", requester_courier_id AS "requesterCourierId",
           NULL::text AS "requesterCourierName", suggested_courier_id AS "suggestedCourierId",
           NULL::text AS "suggestedCourierName", status, reason, notice_minutes AS "noticeMinutes",
           created_at AS "createdAt"`,
        [auth.tenantId, positionId, input.suggestedCourierId ? 'SUBSTITUTION' : 'WITHDRAWAL',
          courierId, input.suggestedCourierId ?? null, input.reason, noticeMinutes],
      );
      await appendEvent(client, auth, position, 'CHANGE_REQUESTED', {
        requestId: created.rows[0]!.id, suggestedCourierId: input.suggestedCourierId ?? null,
        lateNotice: noticeMinutes < position.withdrawal_notice_minutes,
      });
      await publish(client, auth, positionId, 'shift.change.requested', { storeId: position.store_id });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'shift.change.requested', entityType: 'shift_change_request', entityId: created.rows[0]!.id,
        afterData: { positionId, ...input, noticeMinutes }, ...(ip ? { ip } : {}) });
      return { body: created.rows[0]!, statusCode: 202 };
    },
  ));
}

export async function respondShiftConfirmation(
  database: Database, auth: AuthContext, key: string, positionId: string,
  response: 'confirm' | 'decline', reason?: string, ip?: string,
): Promise<IdempotentResult<{ status: string; changeRequestId: string | null }>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `shift-confirmation:${positionId}:${response}`, { response, reason }, async () => {
      const courierId = await ownCourierId(client, auth);
      const position = await loadPosition(client, positionId);
      if (position.assigned_courier_id !== courierId || position.status !== 'FILLED') {
        throw forbidden('Este turno não está aguardando sua confirmação.');
      }
      const confirmation = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM shift_confirmations
         WHERE position_id = $1 AND courier_profile_id = $2 FOR UPDATE`, [positionId, courierId],
      );
      if (!confirmation.rows[0]) throw conflict('A confirmação ainda não foi solicitada.');
      if (confirmation.rows[0].status === 'CONFIRMED' && response === 'confirm') {
        return { body: { status: 'CONFIRMED', changeRequestId: null }, statusCode: 200 };
      }
      if (confirmation.rows[0].status !== 'PENDING') throw conflict('Esta confirmação já foi respondida.');
      await client.query(
        `UPDATE shift_confirmations SET status = $2, responded_at = now() WHERE id = $1`,
        [confirmation.rows[0].id, response === 'confirm' ? 'CONFIRMED' : 'DECLINED'],
      );
      let changeRequestId: string | null = null;
      if (response === 'decline') {
        if (!reason) throw conflict('Informe o motivo para recusar o turno.');
        const noticeMinutes = Math.max(0, Math.floor((position.starts_at.getTime() - Date.now()) / 60_000));
        const change = await client.query<{ id: string }>(
          `INSERT INTO shift_change_requests
             (tenant_id, position_id, request_type, requester_courier_id, reason, notice_minutes)
           VALUES ($1, $2, 'WITHDRAWAL', $3, $4, $5)
           ON CONFLICT (tenant_id, position_id) WHERE status = 'PENDING' DO NOTHING RETURNING id`,
          [auth.tenantId, positionId, courierId, reason, noticeMinutes],
        );
        changeRequestId = change.rows[0]?.id ?? null;
        await publish(client, auth, positionId, 'shift.change.requested', { storeId: position.store_id });
      }
      await appendEvent(client, auth, position, response === 'confirm' ? 'SHIFT_CONFIRMED' : 'SHIFT_DECLINED',
        { courierId, changeRequestId });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: `shift.confirmation.${response}`, entityType: 'shift_position', entityId: positionId,
        afterData: { changeRequestId, reason: reason ?? null }, ...(ip ? { ip } : {}) });
      return { body: { status: response === 'confirm' ? 'CONFIRMED' : 'DECLINED', changeRequestId }, statusCode: 200 };
    },
  ));
}

export async function resolveShiftChangeRequest(
  database: Database, auth: AuthContext, key: string, requestId: string,
  input: { approve: boolean; replacementCourierId?: string | null | undefined; resolutionNote?: string | null | undefined },
  ip?: string,
): Promise<IdempotentResult<{ requestId: string; status: string; positionStatus: string; replacementCourierId: string | null }>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `shift-change.resolve:${requestId}`, input, async () => {
      const request = await client.query<{
        id: string; status: string; position_id: string; suggested_courier_id: string | null;
      }>(`SELECT id, status, position_id, suggested_courier_id FROM shift_change_requests WHERE id = $1 FOR UPDATE`, [requestId]);
      if (!request.rows[0]) throw notFound('Pedido de mudança não encontrado.');
      const position = await loadPosition(client, request.rows[0].position_id);
      if (!canUseStore(auth, position.store_id)) throw forbidden('Você não administra esta loja.');
      if (request.rows[0].status !== 'PENDING') throw conflict('Este pedido já foi analisado.');
      if (!input.approve) {
        await client.query(
          `UPDATE shift_change_requests SET status = 'REJECTED', resolved_by = $2,
             resolution_note = $3, resolved_at = now() WHERE id = $1`,
          [requestId, auth.userId, input.resolutionNote ?? 'Pedido recusado pela gestão.'],
        );
        await appendEvent(client, auth, position, 'CHANGE_REJECTED', { requestId });
        await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
          action: 'shift.change.rejected', entityType: 'shift_change_request', entityId: requestId,
          afterData: { resolutionNote: input.resolutionNote ?? null }, ...(ip ? { ip } : {}) });
        return { body: { requestId, status: 'REJECTED', positionStatus: position.status,
          replacementCourierId: null }, statusCode: 200 };
      }
      const replacementId = input.replacementCourierId ?? request.rows[0].suggested_courier_id;
      if (replacementId) {
        await assertReplacement(client, position, replacementId);
        await client.query(
          `UPDATE shift_positions SET assigned_courier_id = $2, holder_courier_id = NULL,
             status = 'FILLED', updated_by = $3 WHERE id = $1`, [position.id, replacementId, auth.userId],
        );
        await client.query(
          `UPDATE shift_confirmations SET status = 'EXPIRED', responded_at = COALESCE(responded_at, now())
           WHERE position_id = $1 AND courier_profile_id <> $2 AND status = 'PENDING'`, [position.id, replacementId],
        );
        await createReplacementConfirmation(client, position, replacementId);
        await publish(client, auth, position.id, 'shift.confirmation.requested', { courierId: replacementId });
      } else {
        await releaseForCoverage(client, auth, position);
      }
      await client.query(
        `UPDATE shift_change_requests SET status = 'RESOLVED', resolved_by = $2,
           resolution_note = $3, resolved_at = now() WHERE id = $1`,
        [requestId, auth.userId, input.resolutionNote ?? (replacementId ? 'Substituto confirmado.' : 'Vaga reaberta para cobertura.')],
      );
      await appendEvent(client, auth, position, replacementId ? 'SUBSTITUTION_CONFIRMED' : 'POSITION_REOPENED',
        { requestId, replacementCourierId: replacementId ?? null });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'shift.change.resolved', entityType: 'shift_change_request', entityId: requestId,
        afterData: { ...input, replacementCourierId: replacementId ?? null }, ...(ip ? { ip } : {}) });
      return { body: { requestId, status: 'RESOLVED', positionStatus: replacementId ? 'FILLED' : 'AVAILABLE',
        replacementCourierId: replacementId ?? null }, statusCode: 200 };
    },
  ));
}

export async function transferShiftPosition(
  database: Database, auth: AuthContext, key: string, positionId: string,
  input: { courierId: string; reason: string }, ip?: string,
): Promise<IdempotentResult<{ positionId: string; courierId: string; status: string }>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `shift-position.transfer:${positionId}`, input, async () => {
      const position = await loadPosition(client, positionId);
      if (!canUseStore(auth, position.store_id)) throw forbidden('Você não administra esta loja.');
      if (!['AVAILABLE', 'RESERVED', 'FILLED'].includes(position.status)) throw conflict('Este turno não pode ser transferido.');
      if (position.assigned_courier_id === input.courierId) throw conflict('O entregador já é o responsável.');
      await assertReplacement(client, position, input.courierId);
      const previousCourierId = position.assigned_courier_id ?? position.holder_courier_id;
      await client.query(
        `UPDATE shift_positions SET assigned_courier_id = $2, holder_courier_id = NULL,
           status = 'FILLED', updated_by = $3 WHERE id = $1`, [positionId, input.courierId, auth.userId],
      );
      await client.query(
        `UPDATE shift_searches SET status = 'FILLED', winner_courier_id = $2, completed_at = now()
         WHERE position_id = $1 AND status = 'SEARCHING'`, [positionId, input.courierId],
      );
      await client.query(
        `UPDATE shift_search_waves SET status = 'CLOSED'
         WHERE search_id IN (SELECT id FROM shift_searches WHERE position_id = $1) AND status = 'ACTIVE'`, [positionId],
      );
      await client.query(
        `UPDATE shift_search_candidates SET status = CASE WHEN courier_profile_id = $2
             THEN 'ACCEPTED'::shift_search_candidate_status ELSE 'LOST'::shift_search_candidate_status END,
           responded_at = COALESCE(responded_at, now())
         WHERE search_id IN (SELECT id FROM shift_searches WHERE position_id = $1)
           AND status IN ('NOTIFIED', 'ACCEPTED')`, [positionId, input.courierId],
      );
      await client.query(
        `UPDATE shift_confirmations SET status = 'EXPIRED', responded_at = COALESCE(responded_at, now())
         WHERE position_id = $1 AND courier_profile_id <> $2 AND status = 'PENDING'`, [positionId, input.courierId],
      );
      await createReplacementConfirmation(client, position, input.courierId);
      await publish(client, auth, positionId, 'shift.confirmation.requested', { courierId: input.courierId });
      const change = await client.query<{ id: string }>(
        `INSERT INTO shift_change_requests
           (tenant_id, position_id, request_type, requester_courier_id, suggested_courier_id,
            status, reason, notice_minutes, resolved_by, resolution_note, resolved_at)
         VALUES ($1, $2, 'TRANSFER', $3, $4, 'RESOLVED', $5, 0, $6, 'Transferência assistida pela gestão.', now())
         RETURNING id`, [auth.tenantId, positionId, previousCourierId, input.courierId, input.reason, auth.userId],
      );
      await appendEvent(client, auth, position, 'POSITION_TRANSFERRED', {
        requestId: change.rows[0]!.id, previousCourierId, courierId: input.courierId, reason: input.reason,
      });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'shift.position.transferred', entityType: 'shift_position', entityId: positionId,
        afterData: { previousCourierId, ...input }, ...(ip ? { ip } : {}) });
      return { body: { positionId, courierId: input.courierId, status: 'FILLED' }, statusCode: 200 };
    },
  ));
}

export async function cancelShiftPosition(
  database: Database, auth: AuthContext, key: string, positionId: string, reason: string, ip?: string,
): Promise<IdempotentResult<{ positionId: string; status: string }>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `shift-position.cancel:${positionId}`, { reason }, async () => {
      const position = await loadPosition(client, positionId);
      if (!canUseStore(auth, position.store_id)) throw forbidden('Você não administra esta loja.');
      if (['ACTIVE', 'COMPLETED'].includes(position.status)) throw conflict('Um turno ativo ou concluído não pode ser cancelado.');
      if (position.status === 'CANCELLED') return { body: { positionId, status: 'CANCELLED' }, statusCode: 200 };
      await client.query(
        `UPDATE shift_positions SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = $2,
           updated_by = $3 WHERE id = $1`, [positionId, reason, auth.userId],
      );
      await client.query(`UPDATE shift_applications SET status = 'CANCELLED', resolved_by = $2, resolved_at = now()
        WHERE position_id = $1 AND status = 'PENDING'`, [positionId, auth.userId]);
      await client.query(`UPDATE shift_change_requests SET status = 'CANCELLED', resolved_by = $2, resolved_at = now(),
        resolution_note = 'Vaga cancelada pela gestão.' WHERE position_id = $1 AND status = 'PENDING'`, [positionId, auth.userId]);
      await client.query(`UPDATE shift_confirmations SET status = 'EXPIRED', responded_at = COALESCE(responded_at, now())
        WHERE position_id = $1 AND status = 'PENDING'`, [positionId]);
      await client.query(`UPDATE shift_searches SET status = 'CANCELLED', completed_at = now()
        WHERE position_id = $1 AND status = 'SEARCHING'`, [positionId]);
      await client.query(`UPDATE shift_search_waves SET status = 'CLOSED'
        WHERE search_id IN (SELECT id FROM shift_searches WHERE position_id = $1) AND status = 'ACTIVE'`, [positionId]);
      await client.query(`UPDATE shift_search_candidates SET status = 'LOST', responded_at = COALESCE(responded_at, now())
        WHERE search_id IN (SELECT id FROM shift_searches WHERE position_id = $1)
          AND status IN ('NOTIFIED', 'ACCEPTED')`, [positionId]);
      await appendEvent(client, auth, position, 'POSITION_CANCELLED', { reason });
      await publish(client, auth, positionId, 'shift.cancelled', { reason });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'shift.position.cancelled', entityType: 'shift_position', entityId: positionId,
        afterData: { reason }, ...(ip ? { ip } : {}) });
      return { body: { positionId, status: 'CANCELLED' }, statusCode: 200 };
    },
  ));
}

export async function createDueShiftConfirmations(database: Database, limit = 100): Promise<{ created: number }> {
  return withTransaction(database, async (client) => {
    const due = await client.query<{
      tenant_id: string; position_id: string; courier_profile_id: string; starts_at: Date;
    }>(
      `SELECT position.tenant_id, position.id AS position_id, position.assigned_courier_id AS courier_profile_id,
              slot.starts_at
       FROM rastreia.shift_positions position JOIN rastreia.shift_slots slot ON slot.id = position.slot_id
       WHERE position.status = 'FILLED' AND position.assigned_courier_id IS NOT NULL
         AND slot.starts_at > now()
         AND now() >= slot.starts_at - (slot.confirmation_lead_minutes::text || ' minutes')::interval
         AND NOT EXISTS (SELECT 1 FROM rastreia.shift_confirmations confirmation
           WHERE confirmation.position_id = position.id
             AND confirmation.courier_profile_id = position.assigned_courier_id)
       ORDER BY slot.starts_at FOR UPDATE OF position SKIP LOCKED LIMIT $1`, [limit],
    );
    for (const item of due.rows) {
      const confirmation = await client.query<{ id: string }>(
        `INSERT INTO rastreia.shift_confirmations
           (tenant_id, position_id, courier_profile_id, due_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [item.tenant_id, item.position_id, item.courier_profile_id, item.starts_at],
      );
      await client.query(
        `INSERT INTO rastreia.outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'shift_position', $2, 'shift.confirmation.requested', $3::jsonb)`,
        [item.tenant_id, item.position_id,
          JSON.stringify({ confirmationId: confirmation.rows[0]!.id, courierId: item.courier_profile_id })],
      );
    }
    return { created: due.rows.length };
  });
}

export async function sendDueShiftReminders(database: Database, limit = 100): Promise<{ reminded: number }> {
  return withTransaction(database, async (client) => {
    const due = await client.query<{ id: string; tenant_id: string; position_id: string; courier_profile_id: string }>(
      `SELECT confirmation.id, confirmation.tenant_id, confirmation.position_id, confirmation.courier_profile_id
       FROM rastreia.shift_confirmations confirmation
       JOIN rastreia.shift_positions position ON position.id = confirmation.position_id
       JOIN rastreia.shift_slots slot ON slot.id = position.slot_id
       WHERE confirmation.status IN ('PENDING', 'CONFIRMED') AND confirmation.reminder_sent_at IS NULL
         AND position.status = 'FILLED' AND slot.starts_at > now()
         AND now() >= slot.checkin_opens_at - interval '60 minutes'
       ORDER BY slot.checkin_opens_at FOR UPDATE OF confirmation SKIP LOCKED LIMIT $1`, [limit],
    );
    for (const item of due.rows) {
      await client.query(
        `UPDATE rastreia.shift_confirmations SET reminder_sent_at = now() WHERE id = $1`, [item.id],
      );
      await client.query(
        `INSERT INTO rastreia.outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'shift_position', $2, 'shift.reminder', $3::jsonb)`,
        [item.tenant_id, item.position_id, JSON.stringify({ courierId: item.courier_profile_id })],
      );
    }
    return { reminded: due.rows.length };
  });
}
