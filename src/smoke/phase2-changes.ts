import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from '../database/pool.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import { createDueShiftConfirmations, sendDueShiftReminders } from '../modules/shifts/shift-change.service.js';

interface LoginBody { accessToken: string }
interface EntityBody { id: string }
interface ChangeBody { id: string; status: string }
interface PositionBody {
  id: string; status: string; assignedCourierId: string | null; confirmationStatus: string | null;
  pendingChangeRequestId: string | null; changeRequests: ChangeBody[];
}

function body<T>(response: LightMyRequestResponse, expected: number, step: string): T {
  if (response.statusCode !== expected) throw new Error(`${step}: HTTP ${response.statusCode} - ${response.body}`);
  return response.json<T>();
}

loadLocalEnv();
const env = getEnv();
const runId = randomUUID();
const prefix = `changes-smoke-${runId}`;
const app = await buildApp({ env });
const sessions: string[] = [];
const courierIds: string[] = [];
const courierUserIds: string[] = [];
let storeId: string | undefined;

try {
  const managerLogin = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD,
  } }), 200, 'login gestor');
  sessions.push((await verifyAccessToken(env, managerLogin.accessToken)).sessionId);
  const managerHeaders = { authorization: `Bearer ${managerLogin.accessToken}` };
  storeId = body<EntityBody>(await app.inject({ method: 'POST', url: '/stores', headers: managerHeaders, payload: {
    name: `Loja Alterações ${runId.slice(0, 8)}`, externalReference: prefix, addressLine: 'Rua Vergueiro',
    addressNumber: '1000', city: 'São Paulo', state: 'SP', latitude: -23.5745, longitude: -46.6409,
    addressConfidence: 1,
  } }), 201, 'criar loja').id;

  const courierTokens: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const email = `${prefix}-${index}@example.invalid`;
    const password = `Safe-${runId}-${index}`;
    const courier = body<EntityBody>(await app.inject({ method: 'POST', url: '/couriers', headers: managerHeaders, payload: {
      name: `Entregador Alteração ${index + 1}`, email, password, phone: `+551197777770${index}`,
      vehicleType: 'MOTORCYCLE', storeIds: [storeId],
    } }), 201, `criar entregador ${index + 1}`);
    courierIds.push(courier.id);
    const login = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
      tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email, password,
    } }), 200, `login entregador ${index + 1}`);
    sessions.push((await verifyAccessToken(env, login.accessToken)).sessionId);
    courierTokens.push(login.accessToken);
  }

  const createPosition = async (label: string, offsetHours: number, holders: string[] = []): Promise<PositionBody> =>
    body<{ data: PositionBody[] }>(await app.inject({ method: 'POST', url: '/shift-slots',
      headers: { ...managerHeaders, 'idempotency-key': `${prefix}-${label}` }, payload: {
        storeId, label, startsAt: new Date(Date.now() + offsetHours * 60 * 60_000).toISOString(),
        endsAt: new Date(Date.now() + (offsetHours + 2) * 60 * 60_000).toISOString(), headcount: 1,
        holderCourierIds: holders, checkinOpenMinutes: 30, checkinToleranceMinutes: 10,
        checkinRadiusM: 250, searchRadiusM: 10000, compensationCents: 8500, requirements: {},
        autoApproveSubstitutes: true, confirmationLeadMinutes: 1440, withdrawalNoticeMinutes: 720,
      } }), 201, `criar ${label}`).data[0]!;

  const assigned = await createPosition('Confirmação e saída', 1, [courierIds[0]!]);
  body<PositionBody>(await app.inject({ method: 'POST', url: `/shift-positions/${assigned.id}/accept`,
    headers: { authorization: `Bearer ${courierTokens[0]}`, 'idempotency-key': `${prefix}-accept` },
  }), 200, 'aceitar reserva');
  const worker = createPool(env);
  try {
    const confirmation = await createDueShiftConfirmations(worker);
    if (confirmation.created < 1) throw new Error('O worker não criou a confirmação de presença.');
    const reminder = await sendDueShiftReminders(worker);
    if (reminder.reminded < 1) throw new Error('O worker não enviou o lembrete antes do check-in.');
  } finally { await worker.end(); }
  const courierView = body<{ data: PositionBody[] }>(await app.inject({ method: 'GET', url: '/shift-positions',
    headers: { authorization: `Bearer ${courierTokens[0]}` },
  }), 200, 'listar confirmação').data.find((item) => item.id === assigned.id);
  if (courierView?.confirmationStatus !== 'PENDING') throw new Error('A confirmação pendente não apareceu na agenda.');
  body(await app.inject({ method: 'POST', url: `/shift-positions/${assigned.id}/confirmation`,
    headers: { authorization: `Bearer ${courierTokens[0]}`, 'idempotency-key': `${prefix}-confirm` },
    payload: { response: 'confirm' },
  }), 200, 'confirmar presença');
  const withdrawal = body<ChangeBody>(await app.inject({ method: 'POST',
    url: `/shift-positions/${assigned.id}/withdrawal`,
    headers: { authorization: `Bearer ${courierTokens[0]}`, 'idempotency-key': `${prefix}-withdrawal` },
    payload: { reason: 'Imprevisto familiar', suggestedCourierId: courierIds[1] },
  }), 202, 'pedir substituição');
  body(await app.inject({ method: 'POST', url: `/shift-change-requests/${withdrawal.id}/resolve`,
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-resolve-substitute` },
    payload: { approve: true },
  }), 200, 'aprovar substituição');
  const replaced = body<{ data: PositionBody[] }>(await app.inject({ method: 'GET', url: '/shift-positions',
    headers: managerHeaders,
  }), 200, 'validar substituto').data.find((item) => item.id === assigned.id);
  if (replaced?.assignedCourierId !== courierIds[1] || replaced?.confirmationStatus !== 'PENDING') {
    throw new Error('A substituição não transferiu responsabilidade e confirmação.');
  }
  body(await app.inject({ method: 'POST', url: `/shift-positions/${assigned.id}/confirmation`,
    headers: { authorization: `Bearer ${courierTokens[1]}`, 'idempotency-key': `${prefix}-decline` },
    payload: { response: 'decline', reason: 'Conflito de agenda' },
  }), 200, 'recusar substituição');
  const pending = body<{ data: PositionBody[] }>(await app.inject({ method: 'GET', url: '/shift-positions',
    headers: managerHeaders,
  }), 200, 'listar pedido após recusa').data.find((item) => item.id === assigned.id)?.changeRequests
    .find((request) => request.status === 'PENDING');
  if (!pending) throw new Error('A recusa não gerou pedido de cobertura.');
  body(await app.inject({ method: 'POST', url: `/shift-change-requests/${pending.id}/resolve`,
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-reopen` }, payload: { approve: true },
  }), 200, 'reabrir vaga');
  const reopened = body<{ data: PositionBody[] }>(await app.inject({ method: 'GET', url: '/shift-positions',
    headers: managerHeaders,
  }), 200, 'validar vaga reaberta').data.find((item) => item.id === assigned.id);
  if (reopened?.status !== 'AVAILABLE' || reopened.assignedCourierId) throw new Error('A vaga não foi reaberta para cobertura.');

  const transfer = await createPosition('Transferência assistida', 18);
  body(await app.inject({ method: 'POST', url: `/shift-positions/${transfer.id}/transfer`,
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-transfer` },
    payload: { courierId: courierIds[1], reason: 'Reforço de fechamento' },
  }), 200, 'transferir vaga');
  const cancelled = await createPosition('Cancelamento', 24);
  body(await app.inject({ method: 'POST', url: `/shift-positions/${cancelled.id}/cancel`,
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-cancel` }, payload: { reason: 'Loja fechada para inventário' },
  }), 200, 'cancelar vaga');
  const final = body<{ data: PositionBody[] }>(await app.inject({ method: 'GET',
    url: `/shift-positions?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 7 * 86_400_000).toISOString())}&storeId=${storeId}`,
    headers: managerHeaders,
  }), 200, 'consultar visão semanal').data;
  if (final.find((item) => item.id === transfer.id)?.assignedCourierId !== courierIds[1]
      || final.find((item) => item.id === cancelled.id)?.status !== 'CANCELLED') {
    throw new Error('Transferência ou cancelamento ausente na visão semanal.');
  }

  process.stdout.write(`${JSON.stringify({ ok: true, weeklyFilter: true, confirmation: true, reminder: true,
    withdrawal: true, substitution: true, declinedReopened: true, transfer: true, cancellation: true }, null, 2)}\n`);
} finally {
  await app.close();
  const cleanup = createPool(env);
  try {
    await withTransaction(cleanup, async (client) => {
      if (courierIds.length) {
        const users = await client.query<{ user_id: string }>('SELECT user_id FROM rastreia.courier_profiles WHERE id = ANY($1::uuid[])', [courierIds]);
        courierUserIds.push(...users.rows.map((row) => row.user_id));
      }
      const positions = storeId ? await client.query<{ id: string }>(
        `SELECT position.id FROM rastreia.shift_positions position JOIN rastreia.shift_slots slot ON slot.id = position.slot_id WHERE slot.store_id = $1`, [storeId],
      ) : { rows: [] as Array<{ id: string }> };
      const positionIds = positions.rows.map((row) => row.id);
      if (positionIds.length) {
        await client.query('DELETE FROM rastreia.outbox_events WHERE aggregate_id = ANY($1::uuid[])', [positionIds]);
        await client.query('DELETE FROM rastreia.shift_events WHERE position_id = ANY($1::uuid[])', [positionIds]);
      }
      const entities = [storeId, ...courierIds, ...positionIds].filter((id): id is string => Boolean(id));
      await client.query('DELETE FROM rastreia.idempotency_keys WHERE idempotency_key LIKE $1', [`${prefix}%`]);
      if (entities.length) await client.query('DELETE FROM rastreia.audit_logs WHERE entity_id = ANY($1::uuid[])', [entities]);
      if (storeId) await client.query('DELETE FROM rastreia.shift_slots WHERE store_id = $1', [storeId]);
      if (sessions.length) await client.query('DELETE FROM rastreia.refresh_sessions WHERE id = ANY($1::uuid[])', [sessions]);
      if (courierIds.length) {
        await client.query('DELETE FROM rastreia.courier_store_links WHERE courier_profile_id = ANY($1::uuid[])', [courierIds]);
        await client.query('DELETE FROM rastreia.courier_profiles WHERE id = ANY($1::uuid[])', [courierIds]);
      }
      if (courierUserIds.length) {
        await client.query('DELETE FROM rastreia.tenant_users WHERE user_id = ANY($1::uuid[])', [courierUserIds]);
        await client.query('DELETE FROM rastreia.users WHERE id = ANY($1::uuid[])', [courierUserIds]);
      }
      if (storeId) await client.query('DELETE FROM rastreia.stores WHERE id = $1', [storeId]);
    });
  } finally { await cleanup.end(); }
}
