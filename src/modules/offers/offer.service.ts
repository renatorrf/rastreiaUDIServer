import type { PoolClient } from 'pg';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction, withTransaction } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { withIdempotency, type IdempotentResult } from '../../shared/idempotency.js';
import type { AuthContext } from '../auth/auth.types.js';
import type { CreateDeliveryOfferInput, DeliveryOfferView, OfferFinancialEntryView } from './offer.types.js';

const offerSelect = `
  SELECT offer.id, offer.store_id AS "storeId", store.name AS "storeName",
    CASE WHEN $2::text IN ('TENANT_MANAGER', 'STORE_OPERATOR') OR winner.user_id = $4
      THEN offer.delivery_id ELSE NULL END AS "deliveryId",
    CASE WHEN $2::text IN ('TENANT_MANAGER', 'STORE_OPERATOR') OR winner.user_id = $4
      THEN delivery.external_reference ELSE NULL END AS "deliveryReference",
    CASE WHEN $2::text IN ('TENANT_MANAGER', 'STORE_OPERATOR') THEN delivery.recipient_name ELSE NULL END AS "recipientName",
    offer.status, offer.payout_cents AS "payoutCents", offer.currency,
    offer.estimated_distance_m AS "estimatedDistanceM",
    offer.estimated_duration_minutes AS "estimatedDurationMinutes",
    offer.pickup_window_start AS "pickupWindowStart", offer.pickup_window_end AS "pickupWindowEnd",
    offer.delivery_window_end AS "deliveryWindowEnd", offer.expires_at AS "expiresAt",
    offer.search_radius_m AS "searchRadiusM", offer.volume_type AS "volumeType",
    offer.approximate_region AS "approximateRegion", offer.requirements,
    offer.winner_courier_id AS "winnerCourierId", winner_user.name AS "winnerCourierName",
    offer.accepted_at AS "acceptedAt",
    offer.cancellation_reason AS "cancellationReason", offer.cancellation_fee_cents AS "cancellationFeeCents",
    offer.cancelled_by_role AS "cancelledByRole",
    COALESCE((SELECT json_agg(json_build_object(
      'id', revision.id, 'previousPayoutCents', revision.previous_payout_cents,
      'newPayoutCents', revision.new_payout_cents, 'reason', revision.reason, 'createdAt', revision.created_at
    ) ORDER BY revision.created_at DESC) FROM offer_price_revisions revision WHERE revision.offer_id = offer.id), '[]'::json)
      AS "priceRevisions",
    (SELECT count(*)::int FROM offer_candidates all_candidates WHERE all_candidates.offer_id = offer.id) AS "candidateCount",
    own_candidate.status AS "myCandidateStatus", own_candidate.distance_to_pickup_m AS "distanceToPickupM",
    offer.created_at AS "createdAt"
  FROM delivery_offers offer
  JOIN stores store ON store.id = offer.store_id
  JOIN deliveries delivery ON delivery.id = offer.delivery_id
  LEFT JOIN courier_profiles winner ON winner.id = offer.winner_courier_id
  LEFT JOIN users winner_user ON winner_user.id = winner.user_id
  LEFT JOIN courier_profiles own_profile ON own_profile.user_id = $4
  LEFT JOIN offer_candidates own_candidate ON own_candidate.offer_id = offer.id
    AND own_candidate.courier_profile_id = own_profile.id`;

function canUseStore(auth: AuthContext, storeId: string): boolean {
  return auth.role === 'TENANT_MANAGER' || (auth.role === 'STORE_OPERATOR' && auth.storeIds.includes(storeId));
}

async function ownCourierId(client: PoolClient, auth: AuthContext): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT profile.id FROM courier_profiles profile JOIN tenant_users membership ON membership.user_id = profile.user_id
     WHERE profile.user_id = $1 AND membership.tenant_id = $2
       AND profile.status = 'ACTIVE' AND membership.status = 'ACTIVE'`, [auth.userId, auth.tenantId],
  );
  if (!result.rows[0]) throw forbidden('Seu perfil de entregador não está ativo.');
  return result.rows[0].id;
}

async function appendEvent(
  client: PoolClient, auth: AuthContext, offerId: string, eventType: string, metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO delivery_offer_events (tenant_id, offer_id, event_type, actor_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [auth.tenantId, offerId, eventType, auth.userId, JSON.stringify(metadata)],
  );
}

async function publish(client: PoolClient, tenantId: string, offerId: string, eventType: string, payload = {}) {
  await client.query(
    `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'delivery_offer', $2, $3, $4::jsonb)`,
    [tenantId, offerId, eventType, JSON.stringify(payload)],
  );
}

async function loadOffer(client: PoolClient, auth: AuthContext, offerId: string): Promise<DeliveryOfferView> {
  const result = await client.query<DeliveryOfferView>(
    `${offerSelect} WHERE offer.id = $1 AND (
       $2::text = 'TENANT_MANAGER'
       OR ($2::text = 'STORE_OPERATOR' AND offer.store_id = ANY($3::uuid[]))
       OR ($2::text = 'COURIER' AND (own_candidate.id IS NOT NULL OR winner.user_id = $4))
     )`, [offerId, auth.role, auth.storeIds, auth.userId],
  );
  if (!result.rows[0]) throw notFound('Oferta não encontrada.');
  return result.rows[0];
}

export async function listDeliveryOffers(
  database: Database, auth: AuthContext, status?: string,
): Promise<{ data: DeliveryOfferView[] }> {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query<DeliveryOfferView>(
      `${offerSelect} WHERE ($1::delivery_offer_status IS NULL OR offer.status = $1)
       AND ($2::text = 'TENANT_MANAGER'
         OR ($2::text = 'STORE_OPERATOR' AND offer.store_id = ANY($3::uuid[]))
         OR ($2::text = 'COURIER' AND (own_candidate.id IS NOT NULL OR winner.user_id = $4)))
       ORDER BY CASE WHEN offer.status = 'PUBLISHED' THEN 0 ELSE 1 END, offer.expires_at, offer.created_at DESC`,
      [status ?? null, auth.role, auth.storeIds, auth.userId],
    );
    return { data: result.rows };
  });
}

export async function createDeliveryOffer(
  database: Database, auth: AuthContext, key: string, input: CreateDeliveryOfferInput, ip?: string,
): Promise<IdempotentResult<DeliveryOfferView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, 'delivery-offer.create', input, async () => {
      const delivery = await client.query<{
        id: string; store_id: string; status: string; neighborhood: string | null; city: string; state: string;
      }>('SELECT id, store_id, status, neighborhood, city, state FROM deliveries WHERE id = $1 FOR UPDATE', [input.deliveryId]);
      const target = delivery.rows[0];
      if (!target) throw notFound('Entrega não encontrada.');
      if (!canUseStore(auth, target.store_id)) throw forbidden('Você não administra esta loja.');
      if (target.status !== 'AWAITING_COURIER') throw conflict('Somente entregas aguardando entregador podem receber oferta.');
      if (input.expiresAt <= new Date() || input.expiresAt >= input.pickupWindowStart) {
        throw conflict('A oferta deve expirar antes da janela de coleta.');
      }
      const region = input.approximateRegion?.trim()
        || [target.neighborhood, target.city, target.state].filter(Boolean).join(' · ');
      const created = await client.query<{ id: string }>(
        `INSERT INTO delivery_offers
          (tenant_id, store_id, delivery_id, payout_cents, estimated_distance_m,
           estimated_duration_minutes, pickup_window_start, pickup_window_end, delivery_window_end,
           expires_at, search_radius_m, volume_type, approximate_region, requirements, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $15)
         RETURNING id`,
        [auth.tenantId, target.store_id, target.id, input.payoutCents, input.estimatedDistanceM,
          input.estimatedDurationMinutes, input.pickupWindowStart, input.pickupWindowEnd,
          input.deliveryWindowEnd ?? null, input.expiresAt, input.searchRadiusM, input.volumeType,
          region, JSON.stringify(input.requirements), auth.userId],
      );
      const offerId = created.rows[0]!.id;
      const candidates = await client.query(
        `INSERT INTO offer_candidates (tenant_id, offer_id, courier_profile_id, distance_to_pickup_m)
         SELECT $1, $2, eligible.courier_profile_id, eligible.distance_m FROM (
           SELECT profile.id AS courier_profile_id,
             6371000 * acos(LEAST(1.0, GREATEST(-1.0,
               sin(radians(availability.latitude)) * sin(radians(store.latitude))
               + cos(radians(availability.latitude)) * cos(radians(store.latitude))
               * cos(radians(availability.longitude - store.longitude))))) AS distance_m,
             availability.interest_radius_m
           FROM stores store
           JOIN courier_store_links link ON link.tenant_id = $1 AND link.store_id = store.id AND link.status = 'ACTIVE'
           JOIN courier_profiles profile ON profile.id = link.courier_profile_id AND profile.status = 'ACTIVE'
           JOIN courier_availability availability ON availability.tenant_id = $1
             AND availability.courier_profile_id = profile.id AND availability.status = 'AVAILABLE'
           WHERE store.id = $3 AND (availability.available_until IS NULL OR availability.available_until > now())
             AND availability.accuracy <= 100
             AND ($4::jsonb->>'vehicleType' IS NULL OR $4::jsonb->>'vehicleType' = profile.vehicle_type::text)
             AND NOT EXISTS (SELECT 1 FROM deliveries busy WHERE busy.courier_profile_id = profile.id
               AND busy.status IN ('AWAITING_PICKUP', 'COLLECTED', 'IN_ROUTE', 'NEXT_STOP'))
             AND NOT EXISTS (SELECT 1 FROM shift_positions position
               WHERE position.assigned_courier_id = profile.id AND position.status = 'ACTIVE')
             AND courier_is_marketplace_eligible($1, profile.id, store.id)
         ) eligible WHERE eligible.distance_m <= LEAST($5, eligible.interest_radius_m)
         ORDER BY eligible.distance_m LIMIT 100`,
        [auth.tenantId, offerId, target.store_id, JSON.stringify(input.requirements), input.searchRadiusM],
      );
      await appendEvent(client, auth, offerId, 'OFFER_PUBLISHED', { candidateCount: candidates.rowCount });
      await publish(client, auth.tenantId, offerId, 'offer.published', { candidateCount: candidates.rowCount });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'offer.published', entityType: 'delivery_offer', entityId: offerId,
        afterData: { ...input, storeId: target.store_id, candidateCount: candidates.rowCount }, ...(ip ? { ip } : {}) });
      return { body: await loadOffer(client, auth, offerId), statusCode: 201 };
    },
  ));
}

export async function acceptDeliveryOffer(
  database: Database, auth: AuthContext, key: string, offerId: string, ip?: string,
): Promise<IdempotentResult<DeliveryOfferView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `delivery-offer.accept:${offerId}`, {}, async () => {
      const courierId = await ownCourierId(client, auth);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`offer-courier:${courierId}`]);
      const offer = await client.query<{
        id: string; tenant_id: string; delivery_id: string; status: string; expires_at: Date; store_id: string;
      }>('SELECT id, tenant_id, delivery_id, status, expires_at, store_id FROM delivery_offers WHERE id = $1 FOR UPDATE', [offerId]);
      const current = offer.rows[0];
      if (!current) throw notFound('Oferta não encontrada.');
      const candidate = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM offer_candidates WHERE offer_id = $1 AND courier_profile_id = $2 FOR UPDATE',
        [offerId, courierId],
      );
      if (!candidate.rows[0]) throw forbidden('Esta oferta não foi direcionada a você.');
      if (current.status !== 'PUBLISHED') throw conflict('A oferta não está mais disponível.');
      if (current.expires_at <= new Date()) throw conflict('A oferta expirou.');
      if (candidate.rows[0].status !== 'NOTIFIED') throw conflict('Sua resposta a esta oferta já foi registrada.');
      const busy = await client.query(
        `SELECT 1 FROM deliveries WHERE courier_profile_id = $1
         AND status IN ('AWAITING_PICKUP', 'COLLECTED', 'IN_ROUTE', 'NEXT_STOP') LIMIT 1`, [courierId],
      );
      if (busy.rowCount) throw conflict('Conclua seu serviço atual antes de aceitar outra corrida.');
      const delivery = await client.query<{ status: string; version: number }>(
        'SELECT status, version FROM deliveries WHERE id = $1 FOR UPDATE', [current.delivery_id],
      );
      if (delivery.rows[0]?.status !== 'AWAITING_COURIER') throw conflict('A entrega já possui responsável.');
      const version = delivery.rows[0].version;
      await client.query(
        `UPDATE delivery_offers SET status = 'ACCEPTED', winner_courier_id = $2,
           accepted_at = now(), version = version + 1, updated_by = $3 WHERE id = $1`,
        [offerId, courierId, auth.userId],
      );
      await client.query(
        `UPDATE offer_candidates SET status = CASE WHEN courier_profile_id = $2
             THEN 'ACCEPTED'::offer_candidate_status ELSE 'LOST'::offer_candidate_status END,
           responded_at = now() WHERE offer_id = $1 AND status = 'NOTIFIED'`, [offerId, courierId],
      );
      await client.query(
        `UPDATE deliveries SET courier_profile_id = $2, status = 'AWAITING_PICKUP',
           version = version + 2, updated_by = $3 WHERE id = $1`,
        [current.delivery_id, courierId, auth.userId],
      );
      await client.query(
        `INSERT INTO delivery_status_history
          (tenant_id, delivery_id, from_status, to_status, metadata, actor_user_id, delivery_version)
         VALUES ($1, $2, 'AWAITING_COURIER', 'ASSIGNED', $3::jsonb, $4, $5),
                ($1, $2, 'ASSIGNED', 'AWAITING_PICKUP', $3::jsonb, $4, $6)`,
        [auth.tenantId, current.delivery_id, JSON.stringify({ offerId, courierId }), auth.userId, version + 1, version + 2],
      );
      await appendEvent(client, auth, offerId, 'OFFER_ACCEPTED', { courierId, deliveryId: current.delivery_id });
      await publish(client, auth.tenantId, offerId, 'offer.accepted', { courierId, deliveryId: current.delivery_id });
      await client.query(
        `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'delivery', $2, 'delivery.assigned', $3::jsonb)`,
        [auth.tenantId, current.delivery_id, JSON.stringify({ courierId, offerId })],
      );
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'offer.accepted', entityType: 'delivery_offer', entityId: offerId,
        afterData: { courierId, deliveryId: current.delivery_id }, ...(ip ? { ip } : {}) });
      return { body: await loadOffer(client, auth, offerId), statusCode: 200 };
    },
  ));
}

export async function reviseDeliveryOfferPrice(
  database: Database, auth: AuthContext, key: string, offerId: string,
  input: { payoutCents: number; reason: string }, ip?: string,
): Promise<IdempotentResult<DeliveryOfferView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `delivery-offer.price:${offerId}`, input, async () => {
      const offer = await client.query<{ store_id: string; status: string; payout_cents: number }>(
        'SELECT store_id, status, payout_cents FROM delivery_offers WHERE id = $1 FOR UPDATE', [offerId],
      );
      const current = offer.rows[0];
      if (!current) throw notFound('Oferta não encontrada.');
      if (!canUseStore(auth, current.store_id)) throw forbidden('Você não administra esta oferta.');
      if (current.status !== 'PUBLISHED') throw conflict('Somente ofertas publicadas podem ter o valor revisado.');
      if (current.payout_cents === input.payoutCents) throw conflict('Informe um valor diferente do atual.');
      await client.query(
        `INSERT INTO offer_price_revisions
          (tenant_id, offer_id, previous_payout_cents, new_payout_cents, reason, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [auth.tenantId, offerId, current.payout_cents, input.payoutCents, input.reason, auth.userId],
      );
      await client.query(
        'UPDATE delivery_offers SET payout_cents = $2, version = version + 1, updated_by = $3 WHERE id = $1',
        [offerId, input.payoutCents, auth.userId],
      );
      await appendEvent(client, auth, offerId, 'OFFER_PRICE_REVISED', {
        previousPayoutCents: current.payout_cents, newPayoutCents: input.payoutCents, reason: input.reason,
      });
      await publish(client, auth.tenantId, offerId, 'offer.price.revised', {
        previousPayoutCents: current.payout_cents, newPayoutCents: input.payoutCents,
      });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'offer.price.revised', entityType: 'delivery_offer', entityId: offerId,
        beforeData: { payoutCents: current.payout_cents }, afterData: input, ...(ip ? { ip } : {}) });
      return { body: await loadOffer(client, auth, offerId), statusCode: 200 };
    },
  ));
}

async function insertFinancialEntry(
  client: PoolClient, input: { tenantId: string; offerId: string; storeId: string; courierId: string;
    entryType: 'COMPLETION' | 'CANCELLATION_COMPENSATION'; amountCents: number; description: string; metadata?: Record<string, unknown> },
): Promise<void> {
  if (input.amountCents <= 0) return;
  await client.query(
    `INSERT INTO offer_financial_entries
      (tenant_id, offer_id, store_id, courier_profile_id, entry_type,
       store_cost_cents, courier_earning_cents, description, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8::jsonb)
     ON CONFLICT (tenant_id, offer_id, entry_type) DO NOTHING`,
    [input.tenantId, input.offerId, input.storeId, input.courierId, input.entryType,
      input.amountCents, input.description, JSON.stringify(input.metadata ?? {})],
  );
}

export async function cancelDeliveryOffer(
  database: Database, auth: AuthContext, key: string, offerId: string,
  input: { reason: string; compensationCents: number }, ip?: string,
): Promise<IdempotentResult<DeliveryOfferView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `delivery-offer.cancel:${offerId}`, input, async () => {
      const courierId = auth.role === 'COURIER' ? await ownCourierId(client, auth) : null;
      const offer = await client.query<{
        store_id: string; delivery_id: string; status: string; payout_cents: number; winner_courier_id: string | null;
      }>('SELECT store_id, delivery_id, status, payout_cents, winner_courier_id FROM delivery_offers WHERE id = $1 FOR UPDATE', [offerId]);
      const current = offer.rows[0];
      if (!current) throw notFound('Oferta não encontrada.');
      const manager = canUseStore(auth, current.store_id);
      if (!manager && (current.status !== 'ACCEPTED' || current.winner_courier_id !== courierId)) {
        throw forbidden('Você não pode cancelar esta oferta.');
      }
      if (!['PUBLISHED', 'ACCEPTED'].includes(current.status)) throw conflict('Esta oferta já está encerrada.');
      if (auth.role === 'COURIER' && input.compensationCents) {
        throw forbidden('Somente a gestão pode definir compensação.');
      }
      if (input.compensationCents > current.payout_cents) throw conflict('A compensação não pode superar o valor da oferta.');
      if (current.status === 'ACCEPTED') {
        const delivery = await client.query<{ status: string; version: number }>(
          'SELECT status, version FROM deliveries WHERE id = $1 FOR UPDATE', [current.delivery_id],
        );
        if (delivery.rows[0]?.status !== 'AWAITING_PICKUP') {
          throw conflict('Após a coleta, registre uma ocorrência na entrega em vez de cancelar a oferta.');
        }
        await client.query(
          `UPDATE deliveries SET status = 'AWAITING_COURIER', courier_profile_id = NULL,
             version = version + 1, updated_by = $2 WHERE id = $1`, [current.delivery_id, auth.userId],
        );
        await client.query(
          `INSERT INTO delivery_status_history
            (tenant_id, delivery_id, from_status, to_status, reason, metadata, actor_user_id, delivery_version)
           VALUES ($1, $2, 'AWAITING_PICKUP', 'AWAITING_COURIER', $3, $4::jsonb, $5, $6)`,
          [auth.tenantId, current.delivery_id, input.reason,
            JSON.stringify({ offerId, cancelledByRole: auth.role }), auth.userId, delivery.rows[0].version + 1],
        );
      }
      await client.query(
        `UPDATE delivery_offers SET status = 'CANCELLED', cancellation_reason = $2,
           cancellation_fee_cents = $3, cancelled_by_role = $4, cancelled_at = now(),
           version = version + 1, updated_by = $5 WHERE id = $1`,
        [offerId, input.reason, input.compensationCents, auth.role, auth.userId],
      );
      await client.query(
        `UPDATE offer_candidates SET status = 'LOST', responded_at = COALESCE(responded_at, now())
         WHERE offer_id = $1 AND status IN ('NOTIFIED', 'ACCEPTED')`, [offerId],
      );
      if (current.winner_courier_id) await insertFinancialEntry(client, {
        tenantId: auth.tenantId, offerId, storeId: current.store_id, courierId: current.winner_courier_id,
        entryType: 'CANCELLATION_COMPENSATION', amountCents: input.compensationCents,
        description: 'Compensação por cancelamento da corrida.', metadata: { reason: input.reason },
      });
      await appendEvent(client, auth, offerId, 'OFFER_CANCELLED', { ...input, cancelledByRole: auth.role });
      await publish(client, auth.tenantId, offerId, 'offer.cancelled', { compensationCents: input.compensationCents });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'offer.cancelled', entityType: 'delivery_offer', entityId: offerId,
        afterData: { ...input, cancelledByRole: auth.role }, ...(ip ? { ip } : {}) });
      return { body: await loadOffer(client, auth, offerId), statusCode: 200 };
    },
  ));
}

export async function completeOfferForDelivery(
  client: PoolClient, auth: AuthContext, deliveryId: string,
): Promise<void> {
  const result = await client.query<{
    id: string; tenant_id: string; store_id: string; winner_courier_id: string; payout_cents: number;
  }>(`UPDATE delivery_offers SET status = 'COMPLETED', completed_at = now(), version = version + 1,
        updated_by = $2 WHERE delivery_id = $1 AND status = 'ACCEPTED'
      RETURNING id, tenant_id, store_id, winner_courier_id, payout_cents`, [deliveryId, auth.userId]);
  const offer = result.rows[0];
  if (!offer) return;
  await insertFinancialEntry(client, { tenantId: offer.tenant_id, offerId: offer.id, storeId: offer.store_id,
    courierId: offer.winner_courier_id, entryType: 'COMPLETION', amountCents: offer.payout_cents,
    description: 'Corrida concluída.', metadata: { deliveryId } });
  await appendEvent(client, auth, offer.id, 'OFFER_COMPLETED', { deliveryId, payoutCents: offer.payout_cents });
  await publish(client, offer.tenant_id, offer.id, 'offer.completed', { deliveryId });
}

export async function listOfferFinancials(
  database: Database, auth: AuthContext, from: Date, to: Date,
): Promise<{ data: OfferFinancialEntryView[]; summary: {
  storeCostCents: number; courierEarningCents: number; completionCount: number; compensationCount: number;
} }> {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query<OfferFinancialEntryView>(
      `SELECT entry.id, entry.offer_id AS "offerId", entry.store_id AS "storeId", store.name AS "storeName",
        entry.courier_profile_id AS "courierId", courier_user.name AS "courierName",
        entry.entry_type AS "entryType",
        CASE WHEN $1::text IN ('TENANT_MANAGER', 'STORE_OPERATOR') THEN entry.store_cost_cents ELSE NULL END AS "storeCostCents",
        entry.courier_earning_cents AS "courierEarningCents", entry.currency, entry.description,
        entry.occurred_at AS "occurredAt"
       FROM offer_financial_entries entry
       JOIN stores store ON store.id = entry.store_id
       JOIN courier_profiles courier ON courier.id = entry.courier_profile_id
       JOIN users courier_user ON courier_user.id = courier.user_id
       WHERE entry.occurred_at >= $4 AND entry.occurred_at < $5
         AND ($1::text = 'TENANT_MANAGER'
           OR ($1::text = 'STORE_OPERATOR' AND entry.store_id = ANY($2::uuid[]))
           OR ($1::text = 'COURIER' AND courier.user_id = $3))
       ORDER BY entry.occurred_at DESC`, [auth.role, auth.storeIds, auth.userId, from, to],
    );
    return { data: result.rows, summary: {
      storeCostCents: result.rows.reduce((sum, entry) => sum + (entry.storeCostCents ?? 0), 0),
      courierEarningCents: result.rows.reduce((sum, entry) => sum + entry.courierEarningCents, 0),
      completionCount: result.rows.filter((entry) => entry.entryType === 'COMPLETION').length,
      compensationCount: result.rows.filter((entry) => entry.entryType === 'CANCELLATION_COMPENSATION').length,
    } };
  });
}

export async function expireDeliveryOffers(database: Database, limit = 100): Promise<{ expired: number }> {
  return withTransaction(database, async (client) => {
    const offers = await client.query<{ id: string; tenant_id: string }>(
      `UPDATE rastreia.delivery_offers SET status = 'EXPIRED', version = version + 1
       WHERE id IN (SELECT id FROM rastreia.delivery_offers
         WHERE status = 'PUBLISHED' AND expires_at <= now()
         ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT $1)
       RETURNING id, tenant_id`, [limit],
    );
    for (const offer of offers.rows) {
      await client.query(
        `UPDATE rastreia.offer_candidates SET status = 'EXPIRED', responded_at = now()
         WHERE offer_id = $1 AND status = 'NOTIFIED'`, [offer.id],
      );
      await client.query(
        `INSERT INTO rastreia.delivery_offer_events (tenant_id, offer_id, event_type, metadata)
         VALUES ($1, $2, 'OFFER_EXPIRED', '{}'::jsonb)`, [offer.tenant_id, offer.id],
      );
      await client.query(
        `INSERT INTO rastreia.outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'delivery_offer', $2, 'offer.expired', '{}'::jsonb)`, [offer.tenant_id, offer.id],
      );
    }
    return { expired: offers.rows.length };
  });
}
