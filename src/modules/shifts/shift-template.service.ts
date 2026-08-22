import type { PoolClient } from 'pg';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction, withTransaction } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { withIdempotency, type IdempotentResult } from '../../shared/idempotency.js';
import type { AuthContext } from '../auth/auth.types.js';

export interface CreateShiftTemplateInput {
  storeId: string; name: string; weekdays: number[]; localStartTime: string; localEndTime: string;
  headcount: number; holderCourierIds: string[]; checkinOpenMinutes: number;
  checkinToleranceMinutes: number; checkinRadiusM: number; searchRadiusM: number;
  compensationCents: number; requirements: Record<string, unknown>; autoApproveSubstitutes: boolean;
  confirmationLeadMinutes: number; withdrawalNoticeMinutes: number;
}

interface TemplateRow {
  id: string; tenant_id: string; store_id: string; name: string; weekdays: number[];
  local_start_time: string; local_end_time: string; headcount: number;
  checkin_open_minutes: number; checkin_tolerance_minutes: number; checkin_radius_m: number;
  search_radius_m: number; compensation_cents: number; currency: string;
  requirements: Record<string, unknown>; auto_approve_substitutes: boolean; timezone: string;
  confirmation_lead_minutes: number; withdrawal_notice_minutes: number;
}

export interface ShiftTemplateView {
  id: string; storeId: string; storeName: string; name: string; weekdays: number[];
  localStartTime: string; localEndTime: string; headcount: number; holderCourierIds: string[];
  checkinOpenMinutes: number; checkinToleranceMinutes: number; checkinRadiusM: number;
  searchRadiusM: number; compensationCents: number; currency: string;
  autoApproveSubstitutes: boolean; active: boolean; generatedThrough: string | null;
  confirmationLeadMinutes: number; withdrawalNoticeMinutes: number;
}

function canUseStore(auth: AuthContext, storeId: string): boolean {
  return auth.role === 'TENANT_MANAGER' || (auth.role === 'STORE_OPERATOR' && auth.storeIds.includes(storeId));
}

async function templateById(client: PoolClient, templateId: string): Promise<TemplateRow> {
  const result = await client.query<TemplateRow>(
    `SELECT template.id, template.tenant_id, template.store_id, template.name, template.weekdays,
            template.local_start_time::text, template.local_end_time::text, template.headcount,
            template.checkin_open_minutes, template.checkin_tolerance_minutes, template.checkin_radius_m,
            template.search_radius_m, template.compensation_cents, template.currency, template.requirements,
            template.auto_approve_substitutes, template.confirmation_lead_minutes,
            template.withdrawal_notice_minutes, tenant.timezone
     FROM shift_templates template JOIN tenants tenant ON tenant.id = template.tenant_id
     WHERE template.id = $1 AND template.active`,
    [templateId],
  );
  const template = result.rows[0];
  if (!template) throw notFound('Escala recorrente não encontrada.');
  return template;
}

async function materializeTemplate(
  client: PoolClient,
  template: TemplateRow,
  from: string,
  to: string,
  actorUserId: string | null,
  qualified = false,
): Promise<number> {
  const q = qualified ? 'rastreia.' : '';
  const occurrences = await client.query<{ occurrence_date: string; starts_at: Date; ends_at: Date }>(
    `SELECT day::date AS occurrence_date,
            ((day::date + $3::time) AT TIME ZONE $5) AS starts_at,
            ((day::date + $4::time + CASE WHEN $4::time <= $3::time THEN interval '1 day' ELSE interval '0 day' END)
               AT TIME ZONE $5) AS ends_at
     FROM generate_series($1::date, $2::date, interval '1 day') day
     WHERE extract(dow FROM day)::smallint = ANY($6::smallint[])
     ORDER BY day`,
    [from, to, template.local_start_time, template.local_end_time, template.timezone, template.weekdays],
  );
  const holders = await client.query<{ position_number: number; courier_profile_id: string }>(
    `SELECT position_number, courier_profile_id FROM ${q}shift_template_holders
     WHERE template_id = $1 ORDER BY position_number`, [template.id],
  );
  let createdCount = 0;
  for (const occurrence of occurrences.rows) {
    const checkinOpens = new Date(occurrence.starts_at.getTime() - template.checkin_open_minutes * 60_000);
    const checkinDeadline = new Date(occurrence.starts_at.getTime() + template.checkin_tolerance_minutes * 60_000);
    if (checkinDeadline >= occurrence.ends_at) continue;
    const slot = await client.query<{ id: string }>(
      `INSERT INTO ${q}shift_slots
         (tenant_id, store_id, template_id, occurrence_date, label, starts_at, ends_at,
          checkin_opens_at, checkin_deadline_at, checkin_radius_m, search_radius_m,
          compensation_cents, currency, requirements, auto_approve_substitutes,
          confirmation_lead_minutes, withdrawal_notice_minutes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $18)
       ON CONFLICT (tenant_id, template_id, occurrence_date) DO NOTHING RETURNING id`,
      [template.tenant_id, template.store_id, template.id, occurrence.occurrence_date, template.name,
        occurrence.starts_at, occurrence.ends_at, checkinOpens, checkinDeadline, template.checkin_radius_m,
        template.search_radius_m, template.compensation_cents, template.currency,
        JSON.stringify(template.requirements), template.auto_approve_substitutes,
        template.confirmation_lead_minutes, template.withdrawal_notice_minutes, actorUserId],
    );
    const slotId = slot.rows[0]?.id;
    if (!slotId) continue;
    createdCount += 1;
    for (let index = 1; index <= template.headcount; index += 1) {
      const holderId = holders.rows.find((holder) => holder.position_number === index)?.courier_profile_id ?? null;
      const position = await client.query<{ id: string }>(
        `INSERT INTO ${q}shift_positions
           (tenant_id, slot_id, position_number, holder_courier_id, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
        [template.tenant_id, slotId, index, holderId, holderId ? 'RESERVED' : 'AVAILABLE', actorUserId],
      );
      await client.query(
        `INSERT INTO ${q}shift_events (tenant_id, slot_id, position_id, event_type, actor_user_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [template.tenant_id, slotId, position.rows[0]!.id,
          holderId ? 'POSITION_RESERVED' : 'POSITION_AVAILABLE', actorUserId,
          JSON.stringify(holderId ? { holderCourierId: holderId, recurring: true } : { recurring: true })],
      );
      if (!holderId) await client.query(
        `INSERT INTO ${q}outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'shift_position', $2, 'shift.available', $3::jsonb)`,
        [template.tenant_id, position.rows[0]!.id, JSON.stringify({ storeId: template.store_id, recurring: true })],
      );
    }
  }
  await client.query(`UPDATE ${q}shift_templates SET generated_through = GREATEST(COALESCE(generated_through, $2::date), $2::date), updated_by = $3 WHERE id = $1`,
    [template.id, to, actorUserId]);
  return createdCount;
}

export async function listShiftTemplates(database: Database, auth: AuthContext): Promise<{ data: ShiftTemplateView[] }> {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query<ShiftTemplateView>(
      `SELECT template.id, template.store_id AS "storeId", store.name AS "storeName", template.name,
              template.weekdays, template.local_start_time::text AS "localStartTime",
              template.local_end_time::text AS "localEndTime", template.headcount,
              COALESCE((SELECT array_agg(holder.courier_profile_id ORDER BY holder.position_number)
                FROM shift_template_holders holder WHERE holder.template_id = template.id), ARRAY[]::uuid[]) AS "holderCourierIds",
              template.checkin_open_minutes AS "checkinOpenMinutes",
              template.checkin_tolerance_minutes AS "checkinToleranceMinutes",
              template.checkin_radius_m AS "checkinRadiusM", template.search_radius_m AS "searchRadiusM",
              template.compensation_cents AS "compensationCents", template.currency,
              template.auto_approve_substitutes AS "autoApproveSubstitutes",
              template.confirmation_lead_minutes AS "confirmationLeadMinutes",
              template.withdrawal_notice_minutes AS "withdrawalNoticeMinutes", template.active,
              template.generated_through AS "generatedThrough"
       FROM shift_templates template JOIN stores store ON store.id = template.store_id
       WHERE ($1::text = 'TENANT_MANAGER' OR template.store_id = ANY($2::uuid[]))
       ORDER BY template.name`, [auth.role, auth.storeIds],
    );
    return { data: result.rows };
  });
}

export async function createShiftTemplate(
  database: Database, auth: AuthContext, key: string, input: CreateShiftTemplateInput, ip?: string,
): Promise<IdempotentResult<{ template: ShiftTemplateView; generatedSlots: number }>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, 'shift-template.create', input, async () => {
      if (!canUseStore(auth, input.storeId)) throw forbidden('Você não administra esta loja.');
      if (new Set(input.weekdays).size !== input.weekdays.length) throw conflict('Não repita dias da semana.');
      if (input.holderCourierIds.length > input.headcount) throw conflict('Há mais titulares do que posições.');
      if (input.holderCourierIds.length) {
        const linked = await client.query(
          `SELECT courier_profile_id FROM courier_store_links WHERE store_id = $1 AND status = 'ACTIVE'
             AND courier_profile_id = ANY($2::uuid[])`, [input.storeId, input.holderCourierIds],
        );
        if (linked.rowCount !== new Set(input.holderCourierIds).size) throw conflict('Todo titular deve possuir vínculo ativo com a loja.');
      }
      const created = await client.query<{ id: string }>(
        `INSERT INTO shift_templates
           (tenant_id, store_id, name, weekdays, local_start_time, local_end_time, headcount,
            checkin_open_minutes, checkin_tolerance_minutes, checkin_radius_m, search_radius_m,
            compensation_cents, requirements, auto_approve_substitutes,
            confirmation_lead_minutes, withdrawal_notice_minutes, created_by, updated_by)
         VALUES ($1, $2, $3, $4::smallint[], $5::time, $6::time, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $17)
         RETURNING id`,
        [auth.tenantId, input.storeId, input.name, input.weekdays, input.localStartTime, input.localEndTime,
          input.headcount, input.checkinOpenMinutes, input.checkinToleranceMinutes, input.checkinRadiusM,
          input.searchRadiusM, input.compensationCents, JSON.stringify(input.requirements),
          input.autoApproveSubstitutes, input.confirmationLeadMinutes, input.withdrawalNoticeMinutes, auth.userId],
      );
      const templateId = created.rows[0]!.id;
      for (const [index, courierId] of input.holderCourierIds.entries()) {
        await client.query(
          `INSERT INTO shift_template_holders (tenant_id, template_id, position_number, courier_profile_id)
           VALUES ($1, $2, $3, $4)`, [auth.tenantId, templateId, index + 1, courierId],
        );
      }
      const template = await templateById(client, templateId);
      const today = new Date().toISOString().slice(0, 10);
      const horizon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      const generatedSlots = await materializeTemplate(client, template, today, horizon, auth.userId);
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'shift.template.created', entityType: 'shift_template', entityId: templateId,
        afterData: { ...input, generatedSlots }, ...(ip ? { ip } : {}) });
      const listed = await listTemplateInClient(client, templateId);
      return { body: { template: listed, generatedSlots }, statusCode: 201 };
    },
  ));
}

async function listTemplateInClient(client: PoolClient, templateId: string): Promise<ShiftTemplateView> {
  const result = await client.query<ShiftTemplateView>(
    `SELECT template.id, template.store_id AS "storeId", store.name AS "storeName", template.name,
            template.weekdays, template.local_start_time::text AS "localStartTime",
            template.local_end_time::text AS "localEndTime", template.headcount,
            COALESCE((SELECT array_agg(holder.courier_profile_id ORDER BY holder.position_number)
              FROM shift_template_holders holder WHERE holder.template_id = template.id), ARRAY[]::uuid[]) AS "holderCourierIds",
            template.checkin_open_minutes AS "checkinOpenMinutes", template.checkin_tolerance_minutes AS "checkinToleranceMinutes",
            template.checkin_radius_m AS "checkinRadiusM", template.search_radius_m AS "searchRadiusM",
            template.compensation_cents AS "compensationCents", template.currency,
            template.auto_approve_substitutes AS "autoApproveSubstitutes",
            template.confirmation_lead_minutes AS "confirmationLeadMinutes",
            template.withdrawal_notice_minutes AS "withdrawalNoticeMinutes", template.active,
            template.generated_through AS "generatedThrough"
     FROM shift_templates template JOIN stores store ON store.id = template.store_id WHERE template.id = $1`, [templateId],
  );
  return result.rows[0]!;
}

export async function generateShiftTemplate(
  database: Database, auth: AuthContext, templateId: string, through: Date,
): Promise<{ generatedSlots: number }> {
  return withTenantTransaction(database, auth, async (client) => {
    const template = await templateById(client, templateId);
    if (!canUseStore(auth, template.store_id)) throw forbidden('Você não administra esta escala.');
    const from = new Date().toISOString().slice(0, 10);
    const to = through.toISOString().slice(0, 10);
    return { generatedSlots: await materializeTemplate(client, template, from, to, auth.userId) };
  });
}

export async function materializeActiveShiftTemplates(database: Database, horizonDays = 30): Promise<{ generatedSlots: number }> {
  return withTransaction(database, async (client) => {
    const templates = await client.query<TemplateRow>(
      `SELECT template.id, template.tenant_id, template.store_id, template.name, template.weekdays,
              template.local_start_time::text, template.local_end_time::text, template.headcount,
              template.checkin_open_minutes, template.checkin_tolerance_minutes, template.checkin_radius_m,
              template.search_radius_m, template.compensation_cents, template.currency, template.requirements,
              template.auto_approve_substitutes, template.confirmation_lead_minutes,
              template.withdrawal_notice_minutes, tenant.timezone
       FROM rastreia.shift_templates template JOIN rastreia.tenants tenant ON tenant.id = template.tenant_id
       WHERE template.active ORDER BY template.updated_at LIMIT 100`,
    );
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + horizonDays * 86_400_000).toISOString().slice(0, 10);
    let generatedSlots = 0;
    for (const template of templates.rows) generatedSlots += await materializeTemplate(client, template, from, to, null, true);
    return { generatedSlots };
  });
}
