import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from '../database/pool.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import { advanceEmergencySearches } from '../modules/shifts/shift-search.service.js';
import { materializeActiveShiftTemplates } from '../modules/shifts/shift-template.service.js';

interface LoginBody { accessToken: string }
interface EntityBody { id: string }
interface PositionBody {
  id: string; slotId: string; status: string; searchId: string | null; searchStatus: string | null;
  searchWaveNumber: number | null; searchWaveRadiusM: number | null; searchCandidateCount: number;
  mySearchCandidateId: string | null;
}

function body<T>(response: LightMyRequestResponse, expected: number, step: string): T {
  if (response.statusCode !== expected) throw new Error(`${step}: HTTP ${response.statusCode} - ${response.body}`);
  return response.json<T>();
}

loadLocalEnv();
const env = getEnv();
const runId = randomUUID();
const prefix = `wave-smoke-${runId}`;
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
  const store = body<EntityBody>(await app.inject({ method: 'POST', url: '/stores', headers: managerHeaders, payload: {
    name: `Loja Ondas ${runId.slice(0, 8)}`, externalReference: prefix, addressLine: 'Avenida Paulista',
    addressNumber: '1000', city: 'São Paulo', state: 'SP', latitude: -23.561414, longitude: -46.655881,
    addressConfidence: 1,
  } }), 201, 'criar loja');
  storeId = store.id;

  const couriers: Array<{ token: string; latitude: number; longitude: number }> = [];
  const points = [{ latitude: -23.5615, longitude: -46.6558 }, { latitude: -23.6000, longitude: -46.6558 }];
  for (let index = 0; index < 2; index += 1) {
    const email = `${prefix}-${index}@example.invalid`;
    const password = `Safe-${runId}-${index}`;
    const courier = body<EntityBody>(await app.inject({ method: 'POST', url: '/couriers', headers: managerHeaders, payload: {
      name: `Entregador Onda ${index + 1}`, email, password, phone: `+551198888880${index}`,
      vehicleType: 'MOTORCYCLE', storeIds: [storeId],
    } }), 201, `criar entregador ${index + 1}`);
    courierIds.push(courier.id);
    const login = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
      tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email, password,
    } }), 200, `login entregador ${index + 1}`);
    sessions.push((await verifyAccessToken(env, login.accessToken)).sessionId);
    couriers.push({ token: login.accessToken, ...points[index]! });
    body(await app.inject({ method: 'PUT', url: '/courier/availability',
      headers: { authorization: `Bearer ${login.accessToken}` }, payload: {
        available: true, ...points[index]!, accuracy: 8, interestRadiusM: 10000,
        availableUntil: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
      } }), 200, `disponibilidade ${index + 1}`);
  }

  const templateResponse = body<{ generatedSlots: number; template: { id: string } }>(await app.inject({
    method: 'POST', url: '/shift-templates', headers: { ...managerHeaders, 'idempotency-key': `${prefix}-template` },
    payload: {
      storeId, name: 'Escala semanal smoke', weekdays: [new Date().getDay()],
      localStartTime: '09:00', localEndTime: '11:00', headcount: 1, holderCourierIds: [],
      checkinOpenMinutes: 30, checkinToleranceMinutes: 10, checkinRadiusM: 250,
      searchRadiusM: 10000, compensationCents: 8000,
      requirements: { vehicleType: 'MOTORCYCLE' }, autoApproveSubstitutes: true,
    },
  }), 201, 'criar recorrência');
  if (templateResponse.generatedSlots < 4) throw new Error('A recorrência não materializou a janela de 30 dias.');
  const replayGeneration = body<{ generatedSlots: number }>(await app.inject({
    method: 'POST', url: `/shift-templates/${templateResponse.template.id}/generate`, headers: managerHeaders,
    payload: { through: new Date(Date.now() + 30 * 86_400_000).toISOString() },
  }), 200, 'regerar recorrência');
  if (replayGeneration.generatedSlots !== 0) throw new Error('A geração recorrente não foi idempotente.');
  const recurringWorker = createPool(env);
  try {
    const workerGeneration = await materializeActiveShiftTemplates(recurringWorker);
    if (workerGeneration.generatedSlots !== 0) throw new Error('O worker duplicou ocorrências já materializadas.');
  } finally { await recurringWorker.end(); }

  const createPosition = async (suffix: string, offsetHours: number): Promise<PositionBody> => {
    const result = body<{ data: PositionBody[] }>(await app.inject({ method: 'POST', url: '/shift-slots',
      headers: { ...managerHeaders, 'idempotency-key': `${prefix}-slot-${suffix}` }, payload: {
        storeId, label: `Busca ${suffix}`, startsAt: new Date(Date.now() + offsetHours * 60 * 60_000).toISOString(),
        endsAt: new Date(Date.now() + (offsetHours + 2) * 60 * 60_000).toISOString(), headcount: 1,
        holderCourierIds: [], checkinOpenMinutes: 30, checkinToleranceMinutes: 10,
        checkinRadiusM: 250, searchRadiusM: 10000, compensationCents: 9000,
        requirements: { vehicleType: 'MOTORCYCLE' }, autoApproveSubstitutes: true,
      } }), 201, `criar vaga ${suffix}`);
    return result.data[0]!;
  };

  const first = await createPosition('próxima', 12);
  body(await app.inject({ method: 'POST', url: `/shift-positions/${first.id}/search`, headers: managerHeaders,
    payload: { initialRadiusM: 1000, radiusStepM: 5000, waveDurationSeconds: 30 },
  }), 200, 'iniciar primeira onda');
  const managerList = body<{ data: PositionBody[] }>(await app.inject({
    method: 'GET', url: '/shift-positions', headers: managerHeaders,
  }), 200, 'consultar primeira onda').data.find((item) => item.id === first.id)!;
  if (managerList.searchWaveNumber !== 1 || managerList.searchCandidateCount !== 1) {
    throw new Error(`Primeira onda inesperada: ${JSON.stringify(managerList)}.`);
  }
  const nearView = body<{ data: PositionBody[] }>(await app.inject({ method: 'GET', url: '/shift-positions',
    headers: { authorization: `Bearer ${couriers[0]!.token}` },
  }), 200, 'vaga para candidato próximo').data.find((item) => item.id === first.id);
  const farView = body<{ data: PositionBody[] }>(await app.inject({ method: 'GET', url: '/shift-positions',
    headers: { authorization: `Bearer ${couriers[1]!.token}` },
  }), 200, 'vaga para candidato distante').data.find((item) => item.id === first.id);
  if (!nearView?.mySearchCandidateId || farView) throw new Error('A primeira onda não respeitou o raio geográfico.');
  body<PositionBody>(await app.inject({ method: 'POST', url: `/shift-positions/${first.id}/accept`,
    headers: { authorization: `Bearer ${couriers[0]!.token}`, 'idempotency-key': `${prefix}-accept-near` },
  }), 200, 'aceitar primeira onda');

  body(await app.inject({ method: 'PUT', url: '/courier/availability',
    headers: { authorization: `Bearer ${couriers[0]!.token}` }, payload: {
      available: false, interestRadiusM: 10000,
    } }), 200, 'pausar candidato próximo');
  const second = await createPosition('expandida', 16);
  const secondSearch = body<{ searchId: string }>(await app.inject({ method: 'POST',
    url: `/shift-positions/${second.id}/search`, headers: managerHeaders,
    payload: { initialRadiusM: 1000, radiusStepM: 5000, waveDurationSeconds: 30 },
  }), 200, 'iniciar onda vazia');
  const maintenance = createPool(env);
  try {
    const expiredWave = await maintenance.query(
      `UPDATE rastreia.shift_search_waves
       SET opened_at = $2, closes_at = $3
       WHERE search_id = $1 AND status = 'ACTIVE' RETURNING id`,
      [secondSearch.searchId, new Date(Date.now() - 35_000), new Date(Date.now() - 5_000)],
    );
    if (!expiredWave.rowCount) throw new Error('A onda ativa não foi encontrada para expiração controlada.');
    const advanced = await advanceEmergencySearches(maintenance);
    const waveState = await maintenance.query<{ current_wave: number }>(
      'SELECT current_wave FROM rastreia.shift_searches WHERE id = $1', [secondSearch.searchId],
    );
    if (!advanced.advanced && (waveState.rows[0]?.current_wave ?? 0) < 2) {
      throw new Error('A busca não avançou para a segunda onda.');
    }
  } finally { await maintenance.end(); }
  const expanded = body<{ data: PositionBody[] }>(await app.inject({ method: 'GET', url: '/shift-positions',
    headers: { authorization: `Bearer ${couriers[1]!.token}` },
  }), 200, 'consultar onda expandida').data.find((item) => item.id === second.id);
  if (expanded?.searchWaveNumber !== 2 || expanded.searchWaveRadiusM !== 6000 || !expanded.mySearchCandidateId) {
    throw new Error(`Segunda onda não alcançou o candidato distante: ${JSON.stringify(expanded)}.`);
  }
  const accepted = body<PositionBody>(await app.inject({ method: 'POST', url: `/shift-positions/${second.id}/accept`,
    headers: { authorization: `Bearer ${couriers[1]!.token}`, 'idempotency-key': `${prefix}-accept-far` },
  }), 200, 'aceitar onda expandida');
  if (accepted.status !== 'FILLED' || accepted.searchStatus !== 'FILLED') {
    throw new Error('O aceite não encerrou a busca expandida.');
  }

  process.stdout.write(`${JSON.stringify({ ok: true, recurringSlots: templateResponse.generatedSlots,
    recurringIdempotent: true, availabilityScoped: true, firstWaveCandidates: 1,
    distantCourierHiddenInitially: true, expandedWave: 2, expandedRadiusM: 6000,
    searchClosedAtomically: true }, null, 2)}\n`);
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
      const positions = storeId ? await client.query<{ id: string }>(
        `SELECT position.id FROM rastreia.shift_positions position
         JOIN rastreia.shift_slots slot ON slot.id = position.slot_id WHERE slot.store_id = $1`, [storeId],
      ) : { rows: [] as Array<{ id: string }> };
      const positionIds = positions.rows.map((row) => row.id);
      if (positionIds.length) {
        await client.query('DELETE FROM rastreia.outbox_events WHERE aggregate_id = ANY($1::uuid[])', [positionIds]);
        await client.query('DELETE FROM rastreia.shift_events WHERE position_id = ANY($1::uuid[])', [positionIds]);
      }
      const entities = [storeId, ...courierIds, ...positionIds].filter((id): id is string => Boolean(id));
      if (storeId) {
        const templates = await client.query<{ id: string }>('SELECT id FROM rastreia.shift_templates WHERE store_id = $1', [storeId]);
        entities.push(...templates.rows.map((row) => row.id));
        await client.query('DELETE FROM rastreia.shift_slots WHERE store_id = $1', [storeId]);
        await client.query('DELETE FROM rastreia.shift_templates WHERE store_id = $1', [storeId]);
      }
      await client.query('DELETE FROM rastreia.idempotency_keys WHERE idempotency_key LIKE $1', [`${prefix}%`]);
      if (entities.length) await client.query('DELETE FROM rastreia.audit_logs WHERE entity_id = ANY($1::uuid[])', [entities]);
      if (sessions.length) await client.query('DELETE FROM rastreia.refresh_sessions WHERE id = ANY($1::uuid[])', [sessions]);
      if (courierIds.length) {
        await client.query('DELETE FROM rastreia.courier_availability WHERE courier_profile_id = ANY($1::uuid[])', [courierIds]);
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
