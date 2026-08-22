import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from '../database/pool.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';

interface LoginBody { accessToken: string }
interface EntityBody { id: string }
interface OfferBody { id: string; payoutCents: number; status: string; cancellationFeeCents: number;
  priceRevisions: Array<{ previousPayoutCents: number; newPayoutCents: number }> }
interface StatementBody { data: Array<{ id: string; entryType: string; storeCostCents: number | null; courierEarningCents: number }>;
  summary: { storeCostCents: number; courierEarningCents: number; completionCount: number; compensationCount: number } }

function body<T>(response: LightMyRequestResponse, expected: number, step: string): T {
  if (response.statusCode !== expected) throw new Error(`${step}: HTTP ${response.statusCode} - ${response.body}`);
  return response.json<T>();
}

loadLocalEnv();
const env = getEnv();
const runId = randomUUID();
const prefix = `financial-smoke-${runId}`;
const app = await buildApp({ env });
const sessions: string[] = [];
const deliveryIds: string[] = [];
const offerIds: string[] = [];
let storeId: string | undefined;
let courierId: string | undefined;
let courierUserId: string | undefined;

try {
  const manager = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD,
  } }), 200, 'login gestor');
  const managerAuth = await verifyAccessToken(env, manager.accessToken);
  sessions.push(managerAuth.sessionId);
  const managerHeaders = { authorization: `Bearer ${manager.accessToken}` };
  storeId = body<EntityBody>(await app.inject({ method: 'POST', url: '/stores', headers: managerHeaders, payload: {
    name: `Loja Financeiro ${runId.slice(0, 8)}`, externalReference: prefix, addressLine: 'Rua Augusta',
    addressNumber: '500', neighborhood: 'Consolação', city: 'São Paulo', state: 'SP',
    latitude: -23.553, longitude: -46.655, addressConfidence: 1,
  } }), 201, 'criar loja').id;
  const email = `${prefix}@example.invalid`;
  const password = `Safe-${runId}`;
  courierId = body<EntityBody>(await app.inject({ method: 'POST', url: '/couriers', headers: managerHeaders, payload: {
    name: 'Entregador Financeiro', email, password, phone: '+5511944444444',
    vehicleType: 'MOTORCYCLE', storeIds: [storeId],
  } }), 201, 'criar entregador').id;
  const courier = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email, password,
  } }), 200, 'login entregador');
  sessions.push((await verifyAccessToken(env, courier.accessToken)).sessionId);
  const courierHeaders = { authorization: `Bearer ${courier.accessToken}` };
  body(await app.inject({ method: 'PUT', url: '/courier/availability', headers: courierHeaders, payload: {
    available: true, latitude: -23.553, longitude: -46.655, accuracy: 8, interestRadiusM: 10000,
    availableUntil: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
  } }), 200, 'ativar disponibilidade');

  const createDelivery = async (suffix: string) => {
    const delivery = body<EntityBody>(await app.inject({ method: 'POST', url: '/deliveries',
      headers: { ...managerHeaders, 'idempotency-key': `${prefix}-delivery-${suffix}` }, payload: {
        storeId, externalReference: `${prefix}-${suffix}`, recipientName: `Cliente ${suffix}`,
        recipientPhone: '+5511933333333', addressLine: 'Rua da Consolação', addressNumber: '1200',
        neighborhood: 'Consolação', city: 'São Paulo', state: 'SP', latitude: -23.550, longitude: -46.650,
      } }), 201, `criar entrega ${suffix}`);
    deliveryIds.push(delivery.id);
    return delivery.id;
  };
  const publish = async (deliveryId: string, suffix: string, payoutCents = 2400) => {
    const offer = body<OfferBody>(await app.inject({ method: 'POST', url: '/delivery-offers',
      headers: { ...managerHeaders, 'idempotency-key': `${prefix}-offer-${suffix}` }, payload: {
        deliveryId, payoutCents, estimatedDistanceM: 5000, estimatedDurationMinutes: 30,
        pickupWindowStart: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        pickupWindowEnd: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), searchRadiusM: 10000,
        volumeType: 'SMALL', requirements: { vehicleType: 'MOTORCYCLE' },
      } }), 201, `publicar ${suffix}`);
    offerIds.push(offer.id);
    return offer;
  };
  const accept = async (offerId: string, suffix: string) => body<OfferBody>(await app.inject({ method: 'POST',
    url: `/delivery-offers/${offerId}/accept`,
    headers: { ...courierHeaders, 'idempotency-key': `${prefix}-accept-${suffix}` },
  }), 200, `aceitar ${suffix}`);

  const completedDelivery = await createDelivery('conclusao');
  const first = await publish(completedDelivery, 'conclusao');
  const revised = body<OfferBody>(await app.inject({ method: 'POST', url: `/delivery-offers/${first.id}/revise-price`,
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-revise` },
    payload: { payoutCents: 3000, reason: 'Distância recalculada' },
  }), 200, 'revisar preço');
  if (revised.payoutCents !== 3000 || revised.priceRevisions.length !== 1
      || revised.priceRevisions[0]?.previousPayoutCents !== 2400) throw new Error('A revisão de preço não foi auditada.');
  await accept(first.id, 'conclusao');
  for (const action of ['collect', 'start', 'complete']) {
    body(await app.inject({ method: 'POST', url: `/deliveries/${completedDelivery}/${action}`,
      headers: { ...courierHeaders, 'idempotency-key': `${prefix}-${action}` },
    }), 200, `entrega ${action}`);
  }
  const completedOffer = body<{ data: OfferBody[] }>(await app.inject({ method: 'GET', url: '/delivery-offers',
    headers: managerHeaders,
  }), 200, 'validar conclusão').data.find((offer) => offer.id === first.id);
  if (completedOffer?.status !== 'COMPLETED') throw new Error('A conclusão da entrega não liquidou a oferta.');

  const cancelledDelivery = await createDelivery('cancelamento');
  const second = await publish(cancelledDelivery, 'cancelamento', 2000);
  await accept(second.id, 'cancelamento');
  const cancelled = body<OfferBody>(await app.inject({ method: 'POST', url: `/delivery-offers/${second.id}/cancel`,
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-cancel` },
    payload: { reason: 'Cliente alterou a janela', compensationCents: 700 },
  }), 200, 'cancelar com compensação');
  if (cancelled.status !== 'CANCELLED' || cancelled.cancellationFeeCents !== 700) {
    throw new Error('O cancelamento não registrou a compensação.');
  }
  const republished = await publish(cancelledDelivery, 'republicada', 2300);
  if (republished.status !== 'PUBLISHED') throw new Error('A entrega cancelada não pôde receber nova oferta.');

  const managerStatement = body<StatementBody>(await app.inject({ method: 'GET', url: '/offer-financials',
    headers: managerHeaders,
  }), 200, 'extrato gestor');
  const courierStatement = body<StatementBody>(await app.inject({ method: 'GET', url: '/offer-financials',
    headers: courierHeaders,
  }), 200, 'extrato entregador');
  if (managerStatement.summary.storeCostCents !== 3700 || managerStatement.summary.completionCount !== 1
      || managerStatement.summary.compensationCount !== 1 || courierStatement.summary.courierEarningCents !== 3700
      || courierStatement.data.some((entry) => entry.storeCostCents !== null)) {
    throw new Error('Os extratos não refletiram conclusão e compensação com a privacidade correta.');
  }

  const immutableEntry = managerStatement.data[0]!;
  const integrity = createPool(env);
  try {
    const client = await integrity.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rastreia_runtime');
      await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
        [managerAuth.tenantId, managerAuth.userId]);
      let blocked = false;
      try { await client.query(`UPDATE offer_financial_entries SET description = 'alterado' WHERE id = $1`, [immutableEntry.id]); }
      catch { blocked = true; }
      await client.query('ROLLBACK');
      if (!blocked) throw new Error('O livro financeiro permitiu alteração pelo papel de runtime.');
    } finally { client.release(); }
  } finally { await integrity.end(); }

  process.stdout.write(`${JSON.stringify({ ok: true, priceRevision: true, completionCents: 3000,
    cancellationCompensationCents: 700, managerCostCents: 3700, courierEarningCents: 3700,
    immutableLedger: true, republishAfterCancellation: true }, null, 2)}\n`);
} finally {
  await app.close();
  const cleanup = createPool(env);
  try {
    await withTransaction(cleanup, async (client) => {
      if (courierId) {
        const user = await client.query<{ user_id: string }>('SELECT user_id FROM rastreia.courier_profiles WHERE id = $1', [courierId]);
        courierUserId = user.rows[0]?.user_id;
      }
      if (offerIds.length) {
        await client.query('DELETE FROM rastreia.outbox_events WHERE aggregate_id = ANY($1::uuid[])', [offerIds]);
        await client.query('DELETE FROM rastreia.offer_financial_entries WHERE offer_id = ANY($1::uuid[])', [offerIds]);
        await client.query('DELETE FROM rastreia.delivery_offers WHERE id = ANY($1::uuid[])', [offerIds]);
      }
      if (deliveryIds.length) {
        await client.query('DELETE FROM rastreia.outbox_events WHERE aggregate_id = ANY($1::uuid[])', [deliveryIds]);
        await client.query('DELETE FROM rastreia.delivery_status_history WHERE delivery_id = ANY($1::uuid[])', [deliveryIds]);
        await client.query('DELETE FROM rastreia.deliveries WHERE id = ANY($1::uuid[])', [deliveryIds]);
      }
      await client.query('DELETE FROM rastreia.idempotency_keys WHERE idempotency_key LIKE $1', [`${prefix}%`]);
      const entities = [...offerIds, ...deliveryIds, ...(courierId ? [courierId] : []), ...(storeId ? [storeId] : [])];
      if (entities.length) await client.query('DELETE FROM rastreia.audit_logs WHERE entity_id = ANY($1::uuid[])', [entities]);
      if (sessions.length) await client.query('DELETE FROM rastreia.refresh_sessions WHERE id = ANY($1::uuid[])', [sessions]);
      if (courierId) {
        await client.query('DELETE FROM rastreia.courier_availability WHERE courier_profile_id = $1', [courierId]);
        await client.query('DELETE FROM rastreia.courier_store_links WHERE courier_profile_id = $1', [courierId]);
        await client.query('DELETE FROM rastreia.courier_profiles WHERE id = $1', [courierId]);
      }
      if (courierUserId) {
        await client.query('DELETE FROM rastreia.tenant_users WHERE user_id = $1', [courierUserId]);
        await client.query('DELETE FROM rastreia.users WHERE id = $1', [courierUserId]);
      }
      if (storeId) await client.query('DELETE FROM rastreia.stores WHERE id = $1', [storeId]);
    });
  } finally { await cleanup.end(); }
}
