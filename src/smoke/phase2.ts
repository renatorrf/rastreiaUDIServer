import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from '../database/pool.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import { releaseMissedCheckins } from '../modules/shifts/shift.service.js';

interface LoginBody { accessToken: string }
interface EntityBody { id: string }
interface ApplicationBody { id: string; status: string }
interface PositionBody {
  id: string;
  slotId: string;
  status: string;
  assignedCourierId: string | null;
  nextAction: string | null;
  applications: ApplicationBody[];
}

function body<T>(response: LightMyRequestResponse, expectedStatus: number, step: string): T {
  if (response.statusCode !== expectedStatus) {
    throw new Error(`${step}: HTTP ${response.statusCode} - ${response.body}`);
  }
  return response.json<T>();
}

loadLocalEnv();
const env = getEnv();
if (!env.BOOTSTRAP_TENANT_SLUG || !env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_PASSWORD) {
  throw new Error('Preencha as credenciais de bootstrap para o smoke da Fase 2.');
}

const runId = randomUUID();
const prefix = `shift-smoke-${runId}`;
const app = await buildApp({ env });
const sessionIds: string[] = [];
const courierIds: string[] = [];
const courierUserIds: string[] = [];
const slotIds: string[] = [];
const positionIds: string[] = [];
let storeId: string | undefined;

try {
  const managerLogin = body<LoginBody>(await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD },
  }), 200, 'login gestor');
  const managerAuth = await verifyAccessToken(env, managerLogin.accessToken);
  sessionIds.push(managerAuth.sessionId);
  const managerHeaders = { authorization: `Bearer ${managerLogin.accessToken}` };

  const store = body<EntityBody>(await app.inject({
    method: 'POST', url: '/stores', headers: managerHeaders,
    payload: {
      name: `Loja Turnos ${runId.slice(0, 8)}`, externalReference: prefix,
      addressLine: 'Avenida Paulista', addressNumber: '1000', neighborhood: 'Bela Vista',
      city: 'São Paulo', state: 'SP', postalCode: '01310-100',
      latitude: -23.561414, longitude: -46.655881, addressConfidence: 1,
    },
  }), 201, 'criar loja');
  storeId = store.id;

  const courierCredentials: Array<{ email: string; password: string; token?: string }> = [];
  for (let index = 0; index < 2; index += 1) {
    const credentials: { email: string; password: string; token?: string } = {
      email: `${prefix}-${index}@example.invalid`, password: `Safe-${runId}-${index}`,
    };
    courierCredentials.push(credentials);
    const courier = body<EntityBody>(await app.inject({
      method: 'POST', url: '/couriers', headers: managerHeaders,
      payload: {
        name: `Entregador Turno ${index + 1}`, email: credentials.email, password: credentials.password,
        phone: `+551199999990${index}`, vehicleType: 'MOTORCYCLE', storeIds: [storeId],
      },
    }), 201, `criar entregador ${index + 1}`);
    courierIds.push(courier.id);
    const login = body<LoginBody>(await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { tenantSlug: env.BOOTSTRAP_TENANT_SLUG, ...credentials },
    }), 200, `login entregador ${index + 1}`);
    credentials.token = login.accessToken;
    sessionIds.push((await verifyAccessToken(env, login.accessToken)).sessionId);
  }

  const createSlot = async (suffix: string, options: {
    startsAt: Date; endsAt: Date; auto: boolean; holders?: string[];
  }): Promise<PositionBody> => {
    const response = await app.inject({
      method: 'POST', url: '/shift-slots',
      headers: { ...managerHeaders, 'idempotency-key': `${prefix}-create-${suffix}` },
      payload: {
        storeId, label: `Turno ${suffix}`, startsAt: options.startsAt.toISOString(), endsAt: options.endsAt.toISOString(),
        headcount: 1, holderCourierIds: options.holders ?? [], checkinOpenMinutes: 30,
        checkinToleranceMinutes: 10, checkinRadiusM: 250, searchRadiusM: 5000,
        compensationCents: 7500, requirements: {}, autoApproveSubstitutes: options.auto,
      },
    });
    const created = body<{ data: PositionBody[] }>(response, 201, `criar turno ${suffix}`).data[0]!;
    slotIds.push(created.slotId);
    positionIds.push(created.id);
    return created;
  };

  const now = Date.now();
  const contested = await createSlot('concorrente', {
    startsAt: new Date(now + 5 * 60_000), endsAt: new Date(now + 2 * 60 * 60_000), auto: true,
  });
  const acceptResponses = await Promise.all(courierCredentials.map((credentials, index) => app.inject({
    method: 'POST', url: `/shift-positions/${contested.id}/accept`,
    headers: { authorization: `Bearer ${credentials.token!}`, 'idempotency-key': `${prefix}-race-${index}` },
  })));
  const raceStatuses = acceptResponses.map((response) => response.statusCode).sort();
  if (JSON.stringify(raceStatuses) !== JSON.stringify([200, 409])) {
    throw new Error(`Aceite concorrente deveria produzir um vencedor: ${JSON.stringify(raceStatuses)}.`);
  }
  const winningIndex = acceptResponses.findIndex((response) => response.statusCode === 200);
  const winner = body<PositionBody>(acceptResponses[winningIndex]!, 200, 'ler vencedor concorrente');
  if (!winner.assignedCourierId || winner.status !== 'FILLED') throw new Error('A vaga concorrida não possui vencedor único.');

  const overlapping = await createSlot('sobreposto', {
    startsAt: new Date(now + 10 * 60_000), endsAt: new Date(now + 90 * 60_000), auto: true,
  });
  const overlapResponse = await app.inject({
    method: 'POST', url: `/shift-positions/${overlapping.id}/accept`,
    headers: { authorization: `Bearer ${courierCredentials[winningIndex]!.token!}`, 'idempotency-key': `${prefix}-overlap` },
  });
  if (overlapResponse.statusCode !== 409) throw new Error(`Turno sobreposto retornou HTTP ${overlapResponse.statusCode}.`);

  const checkin = body<PositionBody>(await app.inject({
    method: 'POST', url: `/shift-positions/${contested.id}/check-in`,
    headers: { authorization: `Bearer ${courierCredentials[winningIndex]!.token!}`, 'idempotency-key': `${prefix}-checkin` },
    payload: { latitude: -23.561414, longitude: -46.655881, accuracy: 8 },
  }), 200, 'check-in geográfico');
  if (checkin.status !== 'ACTIVE' || checkin.nextAction !== 'CHECK_OUT') throw new Error('Check-in não ativou o turno.');

  const checkout = body<PositionBody>(await app.inject({
    method: 'POST', url: `/shift-positions/${contested.id}/check-out`,
    headers: { authorization: `Bearer ${courierCredentials[winningIndex]!.token!}`, 'idempotency-key': `${prefix}-checkout` },
  }), 200, 'check-out');
  if (checkout.status !== 'COMPLETED') throw new Error('Check-out não concluiu o turno.');

  const manual = await createSlot('manual', {
    startsAt: new Date(now + 4 * 60 * 60_000), endsAt: new Date(now + 6 * 60 * 60_000), auto: false,
  });
  for (const [index, credentials] of courierCredentials.entries()) {
    const response = await app.inject({
      method: 'POST', url: `/shift-positions/${manual.id}/accept`,
      headers: { authorization: `Bearer ${credentials.token!}`, 'idempotency-key': `${prefix}-manual-${index}` },
    });
    body<PositionBody>(response, 202, `candidatura manual ${index + 1}`);
  }
  const managerList = body<{ data: PositionBody[] }>(await app.inject({
    method: 'GET', url: '/shift-positions', headers: managerHeaders,
  }), 200, 'listar candidaturas');
  const manualDetail = managerList.data.find((item) => item.id === manual.id);
  const pending = manualDetail?.applications.filter((application) => application.status === 'PENDING') ?? [];
  if (pending.length !== 2) throw new Error(`Esperadas duas candidaturas manuais, recebidas ${pending.length}.`);
  const approved = body<PositionBody>(await app.inject({
    method: 'POST', url: `/shift-applications/${pending[0]!.id}/approve`,
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-approve` },
  }), 200, 'aprovar substituto');
  if (approved.status !== 'FILLED' || approved.applications.filter((item) => item.status === 'ACCEPTED').length !== 1) {
    throw new Error('A aprovação manual não confirmou exatamente um candidato.');
  }

  const missed = await createSlot('reserva-atrasada', {
    startsAt: new Date(now - 12 * 60_000), endsAt: new Date(now + 60 * 60_000),
    auto: true, holders: [courierIds[1 - winningIndex]!],
  });
  const maintenanceDatabase = createPool(env);
  try {
    const maintenance = await releaseMissedCheckins(maintenanceDatabase);
    if (!maintenance.released) throw new Error('A manutenção não liberou a reserva sem check-in.');
  } finally {
    await maintenanceDatabase.end();
  }
  const afterRelease = body<{ data: PositionBody[] }>(await app.inject({
    method: 'GET', url: '/shift-positions', headers: managerHeaders,
  }), 200, 'verificar liberação automática').data.find((item) => item.id === missed.id);
  if (afterRelease?.status !== 'AVAILABLE') throw new Error('A reserva vencida não voltou a ficar disponível.');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    atomicAcceptance: true,
    uniqueWinner: winner.assignedCourierId,
    overlappingShiftBlocked: true,
    geofencedCheckin: true,
    checkoutCompleted: true,
    manualApprovalCandidates: pending.length,
    missedCheckinReleased: true,
  }, null, 2)}\n`);
} finally {
  await app.close();
  const cleanup = createPool(env);
  try {
    await withTransaction(cleanup, async (client) => {
      if (courierIds.length) {
        const users = await client.query<{ user_id: string }>(
          'SELECT user_id FROM rastreia.courier_profiles WHERE id = ANY($1::uuid[])', [courierIds],
        );
        courierUserIds.push(...users.rows.map((row) => row.user_id));
      }
      if (positionIds.length) {
        await client.query('DELETE FROM rastreia.outbox_events WHERE aggregate_id = ANY($1::uuid[])', [positionIds]);
        await client.query('DELETE FROM rastreia.shift_events WHERE position_id = ANY($1::uuid[])', [positionIds]);
        await client.query('DELETE FROM rastreia.shift_applications WHERE position_id = ANY($1::uuid[])', [positionIds]);
      }
      if (slotIds.length) await client.query('DELETE FROM rastreia.shift_slots WHERE id = ANY($1::uuid[])', [slotIds]);
      await client.query('DELETE FROM rastreia.idempotency_keys WHERE idempotency_key LIKE $1', [`${prefix}%`]);
      const auditedEntities = [storeId, ...courierIds, ...slotIds, ...positionIds].filter((id): id is string => Boolean(id));
      if (auditedEntities.length) await client.query('DELETE FROM rastreia.audit_logs WHERE entity_id = ANY($1::uuid[])', [auditedEntities]);
      if (sessionIds.length) await client.query('DELETE FROM rastreia.refresh_sessions WHERE id = ANY($1::uuid[])', [sessionIds]);
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
  } finally {
    await cleanup.end();
  }
}
