import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from '../database/pool.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';

interface LoginBody { accessToken: string }
interface EntityBody { id: string }
interface OfferBody { id: string; status: string; candidateCount: number }
interface DisputeBody { id: string; status: string; outcome: string | null; evidence: Array<{ evidenceType: string }>;
  events: Array<{ eventType: string }> }
interface ReputationBody { data: Array<{ courierId: string; eligible: boolean; eligibilityReasons: string[];
  completedCount: number; acceptanceRate: number | null; completionRate: number | null; punctualityRate: number | null;
  activeBlocks: Array<{ id: string; reason: string }> }> }

function body<T>(response: LightMyRequestResponse, expected: number, step: string): T {
  if (response.statusCode !== expected) throw new Error(`${step}: HTTP ${response.statusCode} - ${response.body}`);
  return response.json<T>();
}

loadLocalEnv();
const env = getEnv();
const runId = randomUUID();
const prefix = `trust-smoke-${runId}`;
const app = await buildApp({ env });
const sessions: string[] = [];
const deliveryIds: string[] = [];
const offerIds: string[] = [];
const disputeIds: string[] = [];
const blockIds: string[] = [];
let storeId: string | undefined;
let courierId: string | undefined;
let courierUserId: string | undefined;

try {
  const manager = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD,
  } }), 200, 'login gestor');
  sessions.push((await verifyAccessToken(env, manager.accessToken)).sessionId);
  const managerHeaders = { authorization: `Bearer ${manager.accessToken}` };
  storeId = body<EntityBody>(await app.inject({ method: 'POST', url: '/stores', headers: managerHeaders, payload: {
    name: `Loja Confiança ${runId.slice(0, 8)}`, externalReference: prefix, addressLine: 'Rua Augusta',
    addressNumber: '700', neighborhood: 'Consolação', city: 'São Paulo', state: 'SP',
    latitude: -23.553, longitude: -46.655, addressConfidence: 1,
  } }), 201, 'criar loja').id;
  const email = `${prefix}@example.invalid`;
  const password = `Safe-${runId}`;
  courierId = body<EntityBody>(await app.inject({ method: 'POST', url: '/couriers', headers: managerHeaders, payload: {
    name: 'Entregador Confiança', email, password, phone: '+5511944444455',
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
        recipientPhone: '+5511933333344', addressLine: 'Rua da Consolação', addressNumber: '1400',
        neighborhood: 'Consolação', city: 'São Paulo', state: 'SP', latitude: -23.550, longitude: -46.650,
      } }), 201, `criar entrega ${suffix}`);
    deliveryIds.push(delivery.id);
    return delivery.id;
  };
  const publish = async (deliveryId: string, suffix: string) => {
    const offer = body<OfferBody>(await app.inject({ method: 'POST', url: '/delivery-offers',
      headers: { ...managerHeaders, 'idempotency-key': `${prefix}-offer-${suffix}` }, payload: {
        deliveryId, payoutCents: 2500, estimatedDistanceM: 5000, estimatedDurationMinutes: 30,
        pickupWindowStart: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        pickupWindowEnd: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
        deliveryWindowEnd: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), searchRadiusM: 10000,
        volumeType: 'SMALL', requirements: { vehicleType: 'MOTORCYCLE' },
      } }), 201, `publicar ${suffix}`);
    offerIds.push(offer.id);
    return offer;
  };

  const completedDelivery = await createDelivery('concluida');
  const completedOffer = await publish(completedDelivery, 'concluida');
  if (completedOffer.candidateCount !== 1) throw new Error('Entregador elegível não recebeu a oferta inicial.');
  body(await app.inject({ method: 'POST', url: `/delivery-offers/${completedOffer.id}/accept`,
    headers: { ...courierHeaders, 'idempotency-key': `${prefix}-accept` },
  }), 200, 'aceitar corrida');
  for (const action of ['collect', 'start', 'complete']) {
    body(await app.inject({ method: 'POST', url: `/deliveries/${completedDelivery}/${action}`,
      headers: { ...courierHeaders, 'idempotency-key': `${prefix}-${action}` },
    }), 200, `entrega ${action}`);
  }

  const opened = body<DisputeBody>(await app.inject({ method: 'POST',
    url: `/delivery-offers/${completedOffer.id}/disputes`,
    headers: { ...courierHeaders, 'idempotency-key': `${prefix}-dispute` }, payload: {
      category: 'PAYMENT', description: 'O valor liquidado precisa de conferência pela gestão.',
      evidence: [{ evidenceType: 'NOTE', content: 'Extrato conferido após a conclusão da corrida.' }],
    },
  }), 201, 'abrir disputa');
  disputeIds.push(opened.id);
  if (opened.status !== 'OPEN' || opened.evidence.length !== 1 || opened.events[0]?.eventType !== 'DISPUTE_OPENED') {
    throw new Error('A disputa não preservou estado, evidência e linha do tempo.');
  }
  const deniedResolution = await app.inject({ method: 'POST', url: `/offer-disputes/${opened.id}/resolve`,
    headers: { ...courierHeaders, 'idempotency-key': `${prefix}-denied-resolve` },
    payload: { outcome: 'COURIER_FAVORED', resolutionNotes: 'Tentativa de decisão pelo próprio solicitante.' },
  });
  if (deniedResolution.statusCode !== 403) throw new Error('O entregador conseguiu resolver a própria disputa.');
  const evidenced = body<DisputeBody>(await app.inject({ method: 'POST', url: `/offer-disputes/${opened.id}/evidence`,
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-evidence` },
    payload: { evidenceType: 'URL', content: 'https://example.invalid/comprovante' },
  }), 200, 'adicionar evidência');
  if (evidenced.evidence.length !== 2) throw new Error('A evidência adicional não entrou na disputa.');
  body<DisputeBody>(await app.inject({ method: 'POST', url: `/offer-disputes/${opened.id}/review`,
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-review` },
  }), 200, 'iniciar análise');
  const resolved = body<DisputeBody>(await app.inject({ method: 'POST', url: `/offer-disputes/${opened.id}/resolve`,
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-resolve` }, payload: {
      outcome: 'NO_FAULT', resolutionNotes: 'O lançamento financeiro corresponde ao preço aceito e concluído.',
    },
  }), 200, 'resolver disputa');
  if (resolved.status !== 'RESOLVED' || resolved.outcome !== 'NO_FAULT') throw new Error('A decisão não foi registrada.');

  const beforeBlock = body<ReputationBody>(await app.inject({ method: 'GET', url: '/courier-reputation',
    headers: managerHeaders,
  }), 200, 'reputação inicial').data.find((item) => item.courierId === courierId);
  if (!beforeBlock?.eligible || beforeBlock.completedCount !== 1 || beforeBlock.completionRate !== 1
      || beforeBlock.punctualityRate !== 1) throw new Error('Os indicadores básicos não refletiram a corrida concluída.');

  const block = body<EntityBody>(await app.inject({ method: 'POST', url: '/courier-marketplace-blocks',
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-block` }, payload: {
      courierId, storeId, reason: 'Pausa preventiva durante conferência documental.',
      activeUntil: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    },
  }), 201, 'bloquear no marketplace');
  blockIds.push(block.id);
  const blockedReputation = body<ReputationBody>(await app.inject({ method: 'GET', url: '/courier-reputation',
    headers: courierHeaders,
  }), 200, 'reputação bloqueada').data[0];
  if (blockedReputation?.eligible || !blockedReputation?.eligibilityReasons.some((reason) => reason.includes('Bloqueio ativo'))) {
    throw new Error('O bloqueio não ficou explícito para o entregador.');
  }

  const blockedDelivery = await createDelivery('bloqueada');
  const withoutCandidate = await publish(blockedDelivery, 'bloqueada');
  if (withoutCandidate.candidateCount !== 0) throw new Error('O entregador bloqueado ainda recebeu oferta.');
  body(await app.inject({ method: 'POST', url: `/delivery-offers/${withoutCandidate.id}/cancel`,
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-cancel-empty` },
    payload: { reason: 'Republicação após revisão de elegibilidade', compensationCents: 0 },
  }), 200, 'cancelar oferta sem candidato');
  body(await app.inject({ method: 'POST', url: `/courier-marketplace-blocks/${block.id}/revoke`,
    headers: { ...managerHeaders, 'idempotency-key': `${prefix}-revoke` }, payload: { reason: 'Documentação conferida' },
  }), 200, 'revogar bloqueio');
  const republished = await publish(blockedDelivery, 'restaurada');
  if (republished.candidateCount !== 1) throw new Error('A revogação não restaurou a elegibilidade.');

  process.stdout.write(`${JSON.stringify({ ok: true, disputeEvidence: 2, resolutionRoleSeparated: true,
    reputation: { completed: 1, completionRate: 1, punctualityRate: 1 },
    explicitBlock: true, blockedCandidateCount: 0, restoredCandidateCount: 1 }, null, 2)}\n`);
} finally {
  await app.close();
  const cleanup = createPool(env);
  try {
    await withTransaction(cleanup, async (client) => {
      if (courierId) {
        const user = await client.query<{ user_id: string }>('SELECT user_id FROM rastreia.courier_profiles WHERE id = $1', [courierId]);
        courierUserId = user.rows[0]?.user_id;
      }
      if (disputeIds.length) {
        await client.query('DELETE FROM rastreia.offer_dispute_events WHERE dispute_id = ANY($1::uuid[])', [disputeIds]);
        await client.query('DELETE FROM rastreia.offer_dispute_evidence WHERE dispute_id = ANY($1::uuid[])', [disputeIds]);
        await client.query('DELETE FROM rastreia.offer_disputes WHERE id = ANY($1::uuid[])', [disputeIds]);
      }
      if (blockIds.length) await client.query('DELETE FROM rastreia.courier_marketplace_blocks WHERE id = ANY($1::uuid[])', [blockIds]);
      if (offerIds.length) {
        await client.query('DELETE FROM rastreia.outbox_events WHERE aggregate_id = ANY($1::uuid[])', [offerIds]);
        await client.query('DELETE FROM rastreia.offer_financial_entries WHERE offer_id = ANY($1::uuid[])', [offerIds]);
        await client.query('DELETE FROM rastreia.delivery_offers WHERE id = ANY($1::uuid[])', [offerIds]);
      }
      if (disputeIds.length) await client.query('DELETE FROM rastreia.outbox_events WHERE aggregate_id = ANY($1::uuid[])', [disputeIds]);
      if (deliveryIds.length) {
        await client.query('DELETE FROM rastreia.outbox_events WHERE aggregate_id = ANY($1::uuid[])', [deliveryIds]);
        await client.query('DELETE FROM rastreia.delivery_status_history WHERE delivery_id = ANY($1::uuid[])', [deliveryIds]);
        await client.query('DELETE FROM rastreia.deliveries WHERE id = ANY($1::uuid[])', [deliveryIds]);
      }
      await client.query('DELETE FROM rastreia.idempotency_keys WHERE idempotency_key LIKE $1', [`${prefix}%`]);
      const entities = [...offerIds, ...disputeIds, ...blockIds, ...deliveryIds,
        ...(courierId ? [courierId] : []), ...(storeId ? [storeId] : [])];
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
