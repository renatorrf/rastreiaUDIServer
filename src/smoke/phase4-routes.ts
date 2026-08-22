import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from '../database/pool.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import type { RouteMatrixLocation, RouteMatrixProvider, RouteMatrixResult } from '../integrations/geo/geo-provider.js';

interface LoginBody { accessToken: string }
interface EntityBody { id: string }
interface RouteBody { id: string; status: string; completedStops: number; totalStops: number;
  suggestedStopIds: string[] | null; suggestedCurrentDistanceM: number | null; suggestedTotalDistanceM: number | null;
  planAppliedAt: string | null; stops: Array<{ id: string; deliveryId: string; stopType: 'PICKUP' | 'DELIVERY';
    status: string; sequence: number; estimatedArrivalAt: string | null }> }
interface TrackingBody { url: string }
interface MetricsBody { summary: { pickup: { evaluated: number; onTime: number }; delivery: { evaluated: number; onTime: number };
  routes: { started: number; completed: number }; productivity: { delivered: number; deliveriesPerRouteHour: number | null } };
  dimensions: Array<{ dimension: string; id: string; name: string }>; rules: Array<{ key: string }>;
  separation: { reputation: string } }

function body<T>(response: LightMyRequestResponse, expected: number, step: string): T {
  if (response.statusCode !== expected) throw new Error(`${step}: HTTP ${response.statusCode} - ${response.body}`);
  return response.json<T>();
}

class PredictableMatrix implements RouteMatrixProvider {
  async calculate(locations: RouteMatrixLocation[]): Promise<RouteMatrixResult> {
    const base = [[0, 1000, 100], [1000, 0, 1000], [100, 200, 0]];
    return { provider: 'GEOAPIFY', cells: locations.map((_source, source) => locations.map((_target, target) => ({
      distanceM: base[source]?.[target] ?? 0, durationS: Math.round((base[source]?.[target] ?? 0) / 5),
    }))) };
  }
}

loadLocalEnv(); const env = getEnv(); const runId = randomUUID(); const prefix = `routes-smoke-${runId}`;
const app = await buildApp({ env, routeMatrixProvider: new PredictableMatrix() });
const sessions: string[] = []; const deliveryIds: string[] = [];
let storeId: string | undefined; let courierId: string | undefined; let courierUserId: string | undefined;
let routeId: string | undefined;

try {
  const manager = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD,
  } }), 200, 'login gestor');
  sessions.push((await verifyAccessToken(env, manager.accessToken)).sessionId);
  const managerHeaders = { authorization: `Bearer ${manager.accessToken}` };
  storeId = body<EntityBody>(await app.inject({ method: 'POST', url: '/stores', headers: managerHeaders, payload: {
    name: `Loja Rotas ${runId.slice(0, 8)}`, externalReference: prefix, addressLine: 'Rua Augusta', addressNumber: '900',
    neighborhood: 'Consolação', city: 'São Paulo', state: 'SP', latitude: -23.553, longitude: -46.655, addressConfidence: 1,
  } }), 201, 'criar loja').id;
  const email = `${prefix}@example.invalid`; const password = `Safe-${runId}`;
  courierId = body<EntityBody>(await app.inject({ method: 'POST', url: '/couriers', headers: managerHeaders, payload: {
    name: 'Entregador de Lote', email, password, phone: '+5511944444466', vehicleType: 'MOTORCYCLE', storeIds: [storeId],
  } }), 201, 'criar entregador').id;
  const courier = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email, password,
  } }), 200, 'login entregador');
  sessions.push((await verifyAccessToken(env, courier.accessToken)).sessionId);
  const courierHeaders = { authorization: `Bearer ${courier.accessToken}` };

  for (const suffix of ['alpha', 'beta']) {
    const delivery = body<EntityBody>(await app.inject({ method: 'POST', url: '/deliveries',
      headers: { ...managerHeaders, 'idempotency-key': `${prefix}-delivery-${suffix}` }, payload: {
        storeId, externalReference: `${prefix}-${suffix}`, recipientName: `Cliente ${suffix}`,
        recipientPhone: '+5511933333355', addressLine: `Rua Destino ${suffix}`,
        addressNumber: suffix === 'alpha' ? '10' : '20', neighborhood: 'Centro', city: 'São Paulo', state: 'SP',
        latitude: suffix === 'alpha' ? -23.55 : -23.56, longitude: suffix === 'alpha' ? -46.64 : -46.63,
        promisedWindowStart: new Date(Date.now() - 5 * 60_000).toISOString(),
        promisedWindowEnd: new Date(Date.now() + 60 * 60_000).toISOString(),
      } }), 201, `criar entrega ${suffix}`);
    deliveryIds.push(delivery.id);
  }
  let route = body<RouteBody>(await app.inject({ method: 'POST', url: '/routes',
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-route` }, payload: {
      storeId, courierId, deliveryIds, label: 'Rota Centro', plannedStartAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
  }), 201, 'criar lote');
  routeId = route.id;
  if (route.totalStops !== 4 || route.stops.filter((stop) => stop.stopType === 'PICKUP').length !== 2) {
    throw new Error('O lote não criou coleta e destino para cada encomenda.');
  }
  const directCollect = await app.inject({ method: 'POST', url: `/deliveries/${deliveryIds[0]}/collect`,
    headers: { ...courierHeaders, 'idempotency-key': `${prefix}-direct-collect` },
  });
  if (directCollect.statusCode !== 409) throw new Error('A entrega do lote avançou fora da prancheta.');

  route = body<RouteBody>(await app.inject({ method: 'POST', url: `/routes/${route.id}/optimize`,
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-optimize` },
  }), 200, 'calcular sugestão');
  if (!route.suggestedStopIds || route.stops[2]?.deliveryId !== deliveryIds[0]
      || (route.suggestedCurrentDistanceM ?? 0) <= (route.suggestedTotalDistanceM ?? 0)) {
    throw new Error('A prévia alterou a ordem ou não demonstrou o ganho esperado.');
  }
  route = body<RouteBody>(await app.inject({ method: 'POST', url: `/routes/${route.id}/apply-suggestion`,
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-apply-suggestion` },
  }), 200, 'aplicar sugestão');
  if (!route.planAppliedAt || route.stops[2]?.deliveryId !== deliveryIds[1]
      || route.stops.filter((stop) => stop.stopType === 'DELIVERY').some((stop) => !stop.estimatedArrivalAt)) {
    throw new Error('A sugestão explícita não persistiu ordem e ETAs.');
  }

  const firstLink = body<TrackingBody>(await app.inject({ method: 'POST', url: `/deliveries/${deliveryIds[0]}/tracking-link`,
    headers: managerHeaders,
  }), 200, 'emitir link individual');
  const token = firstLink.url.split('/').pop()!;
  const publicView = body<Record<string, unknown>>(await app.inject({ method: 'GET', url: `/public/tracking/${token}` }), 200,
    'consultar acompanhamento individual');
  if (JSON.stringify(publicView).includes(`${prefix}-beta`) || JSON.stringify(publicView).includes('Cliente beta')) {
    throw new Error('O acompanhamento individual revelou outra parada do lote.');
  }
  const publicEta = publicView.eta as { estimatedArrivalAt?: string; message?: string } | null;
  if (!publicEta?.estimatedArrivalAt || publicEta.message !== 'O entregador está concluindo entregas anteriores.') {
    throw new Error('O ETA público não preservou a mensagem genérica entre paradas.');
  }

  for (const stop of route.stops.filter((item) => item.stopType === 'PICKUP')) {
    route = body<RouteBody>(await app.inject({ method: 'POST', url: `/routes/${route.id}/stops/${stop.id}/complete`,
      headers: { ...courierHeaders, 'idempotency-key': `${prefix}-pickup-${stop.id}` },
    }), 200, 'confirmar coleta');
  }
  route = body<RouteBody>(await app.inject({ method: 'POST', url: `/routes/${route.id}/start`,
    headers: { ...courierHeaders, 'idempotency-key': `${prefix}-start` },
  }), 200, 'iniciar rota');
  if (route.status !== 'ACTIVE' || route.stops.find((stop) => stop.status === 'PENDING')?.stopType !== 'DELIVERY') {
    throw new Error('A rota não liberou o primeiro destino após as coletas.');
  }
  for (const stop of route.stops.filter((item) => item.stopType === 'DELIVERY')) {
    route = body<RouteBody>(await app.inject({ method: 'POST', url: `/routes/${route.id}/stops/${stop.id}/complete`,
      headers: { ...courierHeaders, 'idempotency-key': `${prefix}-delivery-stop-${stop.id}` },
    }), 200, 'confirmar destino');
  }
  if (route.status !== 'COMPLETED' || route.completedStops !== 4) throw new Error('O lote não encerrou todas as paradas.');
  const finalDeliveries = body<{ data: Array<{ id: string; status: string }> }>(await app.inject({
    method: 'GET', url: '/deliveries', headers: managerHeaders,
  }), 200, 'validar entregas');
  if (deliveryIds.some((id) => finalDeliveries.data.find((item) => item.id === id)?.status !== 'DELIVERED')) {
    throw new Error('As encomendas não foram concluídas individualmente.');
  }

  const fixtureDatabase = createPool(env);
  try {
    await withTransaction(fixtureDatabase, async (client) => {
      await client.query(`UPDATE rastreia.routes SET started_at = now() - interval '30 minutes' WHERE id = $1`, [routeId]);
      for (const deliveryId of deliveryIds) {
        const offerId = randomUUID();
        await client.query(
          `INSERT INTO rastreia.delivery_offers
             (id, tenant_id, store_id, delivery_id, status, payout_cents, estimated_distance_m,
              estimated_duration_minutes, pickup_window_start, pickup_window_end, delivery_window_end,
              expires_at, approximate_region, winner_courier_id, accepted_at, completed_at)
           SELECT $1, tenant_id, store_id, id, 'COMPLETED', 1000, 1000, 10,
                  now() - interval '30 minutes', now() + interval '30 minutes', promised_window_end,
                  now() + interval '1 hour', 'Centro', courier_profile_id, now() - interval '20 minutes', now()
           FROM rastreia.deliveries WHERE id = $2`, [offerId, deliveryId],
        );
      }
    });
  } finally { await fixtureDatabase.end(); }

  const from = encodeURIComponent(new Date(Date.now() - 2 * 60 * 60_000).toISOString());
  const to = encodeURIComponent(new Date(Date.now() + 2 * 60 * 60_000).toISOString());
  const metricsUrl = `/operational-metrics?from=${from}&to=${to}&storeId=${storeId}&courierId=${courierId}`;
  const metrics = body<MetricsBody>(await app.inject({ method: 'GET', url: metricsUrl, headers: managerHeaders }), 200,
    'consultar SLA e produtividade');
  if (metrics.summary.pickup.evaluated !== 2 || metrics.summary.pickup.onTime !== 2
      || metrics.summary.delivery.evaluated !== 2 || metrics.summary.delivery.onTime !== 2
      || metrics.summary.routes.started !== 1 || metrics.summary.routes.completed !== 1
      || metrics.summary.productivity.delivered !== 2 || !metrics.summary.productivity.deliveriesPerRouteHour
      || metrics.dimensions.filter((item) => item.dimension === 'STORE').length !== 1
      || metrics.dimensions.filter((item) => item.dimension === 'COURIER').length !== 1
      || !metrics.rules.some((rule) => rule.key === 'productivity_v1')
      || !metrics.separation.reputation.includes('não altera')) {
    throw new Error(`Indicadores operacionais divergentes: ${JSON.stringify(metrics)}`);
  }
  const courierMetrics = await app.inject({ method: 'GET', url: metricsUrl, headers: courierHeaders });
  if (courierMetrics.statusCode !== 403) throw new Error('Entregador acessou indicadores reservados à gestão.');
  const csvResponse = await app.inject({ method: 'GET', url: metricsUrl.replace('?', '/export?'),
    headers: managerHeaders });
  if (csvResponse.statusCode !== 200) throw new Error(`exportar indicadores: HTTP ${csvResponse.statusCode}`);
  const csv = csvResponse.body;
  if (!csv.includes('sla_entrega_percentual') || csv.includes('Cliente alpha') || csv.includes('Rua Destino')
      || csv.includes(`${prefix}-alpha`)) {
    throw new Error('A exportação está incompleta ou contém dados de destinatário.');
  }
  process.stdout.write(`${JSON.stringify({ ok: true, deliveries: 2, stops: 4, matrixPreviewWithoutMutation: true,
    explicitSuggestionApply: true, etaPerStop: true, genericPublicMessage: true,
    directTransitionBlocked: true, oneNextStop: true, individualCompletion: true, publicPrivacy: true,
    operationalMetrics: true, explicitSamplesAndRules: true, managementOnly: true, csvWithoutRecipientData: true }, null, 2)}\n`);
} finally {
  await app.close(); const cleanup = createPool(env);
  try { await withTransaction(cleanup, async (client) => {
    if (courierId) { const user = await client.query<{ user_id: string }>(
      'SELECT user_id FROM rastreia.courier_profiles WHERE id = $1', [courierId]); courierUserId = user.rows[0]?.user_id; }
    if (routeId) {
      await client.query('DELETE FROM rastreia.route_events WHERE route_id = $1', [routeId]);
      await client.query('DELETE FROM rastreia.route_stops WHERE route_id = $1', [routeId]);
    }
    if (deliveryIds.length) {
      await client.query('DELETE FROM rastreia.delivery_offers WHERE delivery_id = ANY($1::uuid[])', [deliveryIds]);
      await client.query('DELETE FROM rastreia.tracking_tokens WHERE delivery_id = ANY($1::uuid[])', [deliveryIds]);
      await client.query('DELETE FROM rastreia.outbox_events WHERE aggregate_id = ANY($1::uuid[])', [deliveryIds]);
      await client.query('DELETE FROM rastreia.delivery_status_history WHERE delivery_id = ANY($1::uuid[])', [deliveryIds]);
      await client.query('DELETE FROM rastreia.deliveries WHERE id = ANY($1::uuid[])', [deliveryIds]);
    }
    if (routeId) {
      await client.query('DELETE FROM rastreia.outbox_events WHERE aggregate_id = $1', [routeId]);
      await client.query('DELETE FROM rastreia.routes WHERE id = $1', [routeId]);
    }
    await client.query('DELETE FROM rastreia.idempotency_keys WHERE idempotency_key LIKE $1', [`${prefix}%`]);
    const entities = [...deliveryIds, ...(routeId ? [routeId] : []), ...(courierId ? [courierId] : []), ...(storeId ? [storeId] : [])];
    if (entities.length) await client.query('DELETE FROM rastreia.audit_logs WHERE entity_id = ANY($1::uuid[])', [entities]);
    if (storeId) await client.query(
      `DELETE FROM rastreia.audit_logs
       WHERE action = 'OPERATIONAL_METRICS_EXPORTED' AND after_data->'scope'->>'storeId' = $1`, [storeId],
    );
    if (sessions.length) await client.query('DELETE FROM rastreia.refresh_sessions WHERE id = ANY($1::uuid[])', [sessions]);
    if (courierId) {
      await client.query('DELETE FROM rastreia.courier_store_links WHERE courier_profile_id = $1', [courierId]);
      await client.query('DELETE FROM rastreia.courier_profiles WHERE id = $1', [courierId]);
    }
    if (courierUserId) {
      await client.query('DELETE FROM rastreia.tenant_users WHERE user_id = $1', [courierUserId]);
      await client.query('DELETE FROM rastreia.users WHERE id = $1', [courierUserId]);
    }
    if (storeId) await client.query('DELETE FROM rastreia.stores WHERE id = $1', [storeId]);
  }); } finally { await cleanup.end(); }
}
