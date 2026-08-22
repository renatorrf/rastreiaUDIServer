import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from '../database/pool.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import { expireDeliveryOffers } from '../modules/offers/offer.service.js';

interface LoginBody { accessToken: string }
interface EntityBody { id: string }
interface OfferBody {
  id: string; deliveryId: string | null; deliveryReference: string | null; recipientName: string | null; status: string;
  winnerCourierId: string | null; myCandidateStatus: string | null; candidateCount: number;
}

function body<T>(response: LightMyRequestResponse, expected: number, step: string): T {
  if (response.statusCode !== expected) throw new Error(`${step}: HTTP ${response.statusCode} - ${response.body}`);
  return response.json<T>();
}

loadLocalEnv();
const env = getEnv();
const runId = randomUUID();
const prefix = `offer-smoke-${runId}`;
const app = await buildApp({ env });
const sessions: string[] = [];
const courierIds: string[] = [];
const courierUserIds: string[] = [];
const deliveryIds: string[] = [];
const offerIds: string[] = [];
let storeId: string | undefined;

try {
  const manager = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD,
  } }), 200, 'login gestor');
  sessions.push((await verifyAccessToken(env, manager.accessToken)).sessionId);
  const managerHeaders = { authorization: `Bearer ${manager.accessToken}` };
  storeId = body<EntityBody>(await app.inject({ method: 'POST', url: '/stores', headers: managerHeaders, payload: {
    name: `Loja Ofertas ${runId.slice(0, 8)}`, externalReference: prefix, addressLine: 'Avenida Paulista',
    addressNumber: '900', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP',
    latitude: -23.565, longitude: -46.652, addressConfidence: 1,
  } }), 201, 'criar loja').id;

  const tokens: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const email = `${prefix}-${index}@example.invalid`;
    const password = `Safe-${runId}-${index}`;
    const courier = body<EntityBody>(await app.inject({ method: 'POST', url: '/couriers', headers: managerHeaders, payload: {
      name: `Candidato ${index + 1}`, email, password, phone: `+551196666660${index}`,
      vehicleType: 'MOTORCYCLE', storeIds: [storeId],
    } }), 201, `criar candidato ${index + 1}`);
    courierIds.push(courier.id);
    const login = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
      tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email, password,
    } }), 200, `login candidato ${index + 1}`);
    sessions.push((await verifyAccessToken(env, login.accessToken)).sessionId);
    tokens.push(login.accessToken);
    body(await app.inject({ method: 'PUT', url: '/courier/availability',
      headers: { authorization: `Bearer ${login.accessToken}` }, payload: {
        available: true, latitude: -23.565 + index * .001, longitude: -46.652, accuracy: 8,
        interestRadiusM: 10000, availableUntil: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
      } }), 200, `ativar candidato ${index + 1}`);
  }

  const createDelivery = async (suffix: string): Promise<string> => {
    const delivery = body<EntityBody>(await app.inject({ method: 'POST', url: '/deliveries',
      headers: { ...managerHeaders, 'idempotency-key': `${prefix}-delivery-${suffix}` }, payload: {
        storeId, externalReference: `${prefix}-${suffix}`, recipientName: `Destinatário ${suffix}`,
        recipientPhone: '+5511955555555', addressLine: 'Rua Haddock Lobo', addressNumber: '300',
        neighborhood: 'Cerqueira César', city: 'São Paulo', state: 'SP', postalCode: '01414-000',
        latitude: -23.558, longitude: -46.662, addressConfidence: 1,
      } }), 201, `criar entrega ${suffix}`);
    deliveryIds.push(delivery.id);
    return delivery.id;
  };
  const publish = async (deliveryId: string, suffix: string): Promise<OfferBody> => {
    const offer = body<OfferBody>(await app.inject({ method: 'POST', url: '/delivery-offers',
      headers: { ...managerHeaders, 'idempotency-key': `${prefix}-offer-${suffix}` }, payload: {
        deliveryId, payoutCents: 2400, estimatedDistanceM: 6200, estimatedDurationMinutes: 38,
        pickupWindowStart: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        pickupWindowEnd: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
        deliveryWindowEnd: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), searchRadiusM: 10000,
        volumeType: 'SMALL', requirements: { vehicleType: 'MOTORCYCLE' },
      } }), 201, `publicar oferta ${suffix}`);
    offerIds.push(offer.id);
    return offer;
  };

  const deliveryId = await createDelivery('disputa');
  const offer = await publish(deliveryId, 'disputa');
  if (offer.candidateCount !== 2 || offer.recipientName !== 'Destinatário disputa') {
    throw new Error('A publicação não encontrou os dois candidatos ou não retornou a visão gerencial.');
  }
  for (let index = 0; index < 2; index += 1) {
    const courierOffer = body<{ data: OfferBody[] }>(await app.inject({ method: 'GET', url: '/delivery-offers',
      headers: { authorization: `Bearer ${tokens[index]}` },
    }), 200, `listar candidato ${index + 1}`).data.find((item) => item.id === offer.id);
    if (!courierOffer || courierOffer.recipientName !== null || courierOffer.deliveryId !== null
        || courierOffer.deliveryReference !== null
        || courierOffer.myCandidateStatus !== 'NOTIFIED') {
      throw new Error('A visão pré-aceite expôs dados privados ou ocultou a oferta elegível.');
    }
  }
  const attempts = await Promise.all(tokens.map((token, index) => app.inject({ method: 'POST',
    url: `/delivery-offers/${offer.id}/accept`,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': `${prefix}-accept-${index}` },
  })));
  const accepted = attempts.filter((response) => response.statusCode === 200);
  const rejected = attempts.filter((response) => response.statusCode === 409);
  if (accepted.length !== 1 || rejected.length !== 1) throw new Error('O aceite concorrente não produziu um único vencedor.');
  const winnerOffer = accepted[0]!.json<OfferBody>();
  if (winnerOffer.status !== 'ACCEPTED' || !winnerOffer.deliveryId || !winnerOffer.winnerCourierId) {
    throw new Error('O vencedor não recebeu a entrega aceita.');
  }
  const managerOffer = body<{ data: OfferBody[] }>(await app.inject({ method: 'GET', url: '/delivery-offers',
    headers: managerHeaders,
  }), 200, 'validar encerramento').data.find((item) => item.id === offer.id);
  if (managerOffer?.winnerCourierId !== winnerOffer.winnerCourierId) throw new Error('O vencedor não persistiu na oferta.');

  const expiringDelivery = await createDelivery('expira');
  const expiring = await publish(expiringDelivery, 'expira');
  const maintenance = createPool(env);
  try {
    await maintenance.query(
      `UPDATE rastreia.delivery_offers SET expires_at = created_at + interval '1 millisecond' WHERE id = $1`, [expiring.id],
    );
    const expired = await expireDeliveryOffers(maintenance);
    if (expired.expired < 1) throw new Error('O worker não expirou a oferta vencida.');
  } finally { await maintenance.end(); }
  const expiredView = body<{ data: OfferBody[] }>(await app.inject({ method: 'GET', url: '/delivery-offers',
    headers: managerHeaders,
  }), 200, 'validar expiração').data.find((item) => item.id === expiring.id);
  if (expiredView?.status !== 'EXPIRED') throw new Error('A expiração não ficou visível na consulta.');

  process.stdout.write(`${JSON.stringify({ ok: true, candidates: 2, preAcceptPrivacy: true,
    atomicWinner: winnerOffer.winnerCourierId, loserConflict: true, deliveryAssigned: true, expiration: true }, null, 2)}\n`);
} finally {
  await app.close();
  const cleanup = createPool(env);
  try {
    await withTransaction(cleanup, async (client) => {
      if (courierIds.length) {
        const users = await client.query<{ user_id: string }>('SELECT user_id FROM rastreia.courier_profiles WHERE id = ANY($1::uuid[])', [courierIds]);
        courierUserIds.push(...users.rows.map((row) => row.user_id));
      }
      if (offerIds.length) {
        await client.query('DELETE FROM rastreia.outbox_events WHERE aggregate_id = ANY($1::uuid[])', [offerIds]);
        await client.query('DELETE FROM rastreia.delivery_offers WHERE id = ANY($1::uuid[])', [offerIds]);
      }
      if (deliveryIds.length) {
        await client.query('DELETE FROM rastreia.outbox_events WHERE aggregate_id = ANY($1::uuid[])', [deliveryIds]);
        await client.query('DELETE FROM rastreia.delivery_status_history WHERE delivery_id = ANY($1::uuid[])', [deliveryIds]);
        await client.query('DELETE FROM rastreia.deliveries WHERE id = ANY($1::uuid[])', [deliveryIds]);
      }
      await client.query('DELETE FROM rastreia.idempotency_keys WHERE idempotency_key LIKE $1', [`${prefix}%`]);
      const entities = [...offerIds, ...deliveryIds, ...courierIds, ...(storeId ? [storeId] : [])];
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
