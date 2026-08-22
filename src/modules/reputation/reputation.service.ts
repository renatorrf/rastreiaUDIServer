import type { PoolClient } from 'pg';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { withIdempotency, type IdempotentResult } from '../../shared/idempotency.js';
import type { AuthContext } from '../auth/auth.types.js';
import type {
  CourierReputationView, DisputeCategory, DisputeOutcome, DisputeStatus, MarketplaceBlockView, OfferDisputeView,
} from './reputation.types.js';

const disputeSelect = `
  SELECT dispute.id, dispute.offer_id AS "offerId", dispute.store_id AS "storeId", store.name AS "storeName",
    dispute.courier_profile_id AS "courierId", courier_user.name AS "courierName",
    delivery.external_reference AS "deliveryReference", dispute.status, dispute.category, dispute.description,
    opened_user.name AS "openedByName", dispute.opened_by_role AS "openedByRole",
    dispute.response_due_at AS "responseDueAt", dispute.review_started_at AS "reviewStartedAt",
    dispute.outcome, dispute.resolution_notes AS "resolutionNotes", dispute.resolved_at AS "resolvedAt",
    COALESCE((SELECT json_agg(json_build_object(
      'id', evidence.id, 'evidenceType', evidence.evidence_type, 'content', evidence.content,
      'submittedByName', evidence_user.name, 'submittedByRole', evidence.submitted_by_role,
      'createdAt', evidence.created_at) ORDER BY evidence.created_at)
      FROM offer_dispute_evidence evidence LEFT JOIN users evidence_user ON evidence_user.id = evidence.submitted_by_user_id
      WHERE evidence.dispute_id = dispute.id), '[]'::json) AS evidence,
    COALESCE((SELECT json_agg(json_build_object(
      'id', event.id, 'eventType', event.event_type, 'actorName', event_user.name,
      'metadata', event.metadata, 'createdAt', event.created_at) ORDER BY event.created_at)
      FROM offer_dispute_events event LEFT JOIN users event_user ON event_user.id = event.actor_user_id
      WHERE event.dispute_id = dispute.id), '[]'::json) AS events,
    dispute.created_at AS "createdAt", dispute.updated_at AS "updatedAt"
  FROM offer_disputes dispute
  JOIN delivery_offers offer ON offer.id = dispute.offer_id
  JOIN deliveries delivery ON delivery.id = offer.delivery_id
  JOIN stores store ON store.id = dispute.store_id
  JOIN courier_profiles courier ON courier.id = dispute.courier_profile_id
  JOIN users courier_user ON courier_user.id = courier.user_id
  LEFT JOIN users opened_user ON opened_user.id = dispute.opened_by_user_id`;

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

async function appendDisputeEvent(
  client: PoolClient, auth: AuthContext, disputeId: string, eventType: string, metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO offer_dispute_events (tenant_id, dispute_id, event_type, actor_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [auth.tenantId, disputeId, eventType, auth.userId, JSON.stringify(metadata)],
  );
}

async function loadDispute(client: PoolClient, auth: AuthContext, disputeId: string): Promise<OfferDisputeView> {
  const result = await client.query<OfferDisputeView>(
    `${disputeSelect} WHERE dispute.id = $1 AND (
       $2::text = 'TENANT_MANAGER'
       OR ($2::text = 'STORE_OPERATOR' AND dispute.store_id = ANY($3::uuid[]))
       OR ($2::text = 'COURIER' AND courier.user_id = $4))`,
    [disputeId, auth.role, auth.storeIds, auth.userId],
  );
  if (!result.rows[0]) throw notFound('Disputa não encontrada.');
  return result.rows[0];
}

export async function listOfferDisputes(
  database: Database, auth: AuthContext, status?: DisputeStatus,
): Promise<{ data: OfferDisputeView[] }> {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query<OfferDisputeView>(
      `${disputeSelect} WHERE ($1::offer_dispute_status IS NULL OR dispute.status = $1)
       AND ($2::text = 'TENANT_MANAGER'
         OR ($2::text = 'STORE_OPERATOR' AND dispute.store_id = ANY($3::uuid[]))
         OR ($2::text = 'COURIER' AND courier.user_id = $4))
       ORDER BY CASE dispute.status WHEN 'OPEN' THEN 0 WHEN 'UNDER_REVIEW' THEN 1 ELSE 2 END,
         dispute.response_due_at, dispute.updated_at DESC`,
      [status ?? null, auth.role, auth.storeIds, auth.userId],
    );
    return { data: result.rows };
  });
}

export async function openOfferDispute(
  database: Database, auth: AuthContext, key: string, offerId: string,
  input: { category: DisputeCategory; description: string; evidence: Array<{ evidenceType: 'NOTE' | 'URL'; content: string }> },
  ip?: string,
): Promise<IdempotentResult<OfferDisputeView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `offer-dispute.open:${offerId}`, input, async () => {
      const offer = await client.query<{
        store_id: string; winner_courier_id: string | null; status: string;
        accepted_at: Date | null; completed_at: Date | null; cancelled_at: Date | null;
      }>(`SELECT store_id, winner_courier_id, status, accepted_at, completed_at, cancelled_at
          FROM delivery_offers WHERE id = $1 FOR UPDATE`, [offerId]);
      const current = offer.rows[0];
      if (!current) throw notFound('Oferta não encontrada.');
      if (!current.winner_courier_id || !['ACCEPTED', 'COMPLETED', 'CANCELLED'].includes(current.status)) {
        throw conflict('A disputa exige uma oferta aceita, concluída ou cancelada.');
      }
      const ownsOffer = auth.role === 'COURIER' && current.winner_courier_id === await ownCourierId(client, auth);
      if (!canUseStore(auth, current.store_id) && !ownsOffer) throw forbidden('Você não participa desta oferta.');
      const referenceAt = current.completed_at ?? current.cancelled_at ?? current.accepted_at;
      if (referenceAt && referenceAt.getTime() < Date.now() - 7 * 24 * 60 * 60_000) {
        throw conflict('O prazo de 7 dias para abrir a disputa foi encerrado.');
      }
      const created = await client.query<{ id: string }>(
        `INSERT INTO offer_disputes
          (tenant_id, offer_id, store_id, courier_profile_id, category, description, opened_by_user_id, opened_by_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [auth.tenantId, offerId, current.store_id, current.winner_courier_id,
          input.category, input.description, auth.userId, auth.role],
      );
      const disputeId = created.rows[0]!.id;
      for (const evidence of input.evidence) {
        await client.query(
          `INSERT INTO offer_dispute_evidence
            (tenant_id, dispute_id, evidence_type, content, submitted_by_user_id, submitted_by_role)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [auth.tenantId, disputeId, evidence.evidenceType, evidence.content, auth.userId, auth.role],
        );
      }
      await appendDisputeEvent(client, auth, disputeId, 'DISPUTE_OPENED', { category: input.category });
      await client.query(
        `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'offer_dispute', $2, 'offer.dispute.opened', $3::jsonb)`,
        [auth.tenantId, disputeId, JSON.stringify({ offerId, storeId: current.store_id })],
      );
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'offer.dispute.opened', entityType: 'offer_dispute', entityId: disputeId,
        afterData: { offerId, category: input.category, evidenceCount: input.evidence.length }, ...(ip ? { ip } : {}) });
      return { body: await loadDispute(client, auth, disputeId), statusCode: 201 };
    },
  ));
}

export async function addDisputeEvidence(
  database: Database, auth: AuthContext, key: string, disputeId: string,
  input: { evidenceType: 'NOTE' | 'URL'; content: string }, ip?: string,
): Promise<IdempotentResult<OfferDisputeView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `offer-dispute.evidence:${disputeId}`, input, async () => {
      const dispute = await loadDispute(client, auth, disputeId);
      if (dispute.status === 'RESOLVED') throw conflict('A disputa já foi resolvida.');
      if (auth.role !== 'TENANT_MANAGER' && new Date(dispute.responseDueAt) <= new Date()) {
        throw conflict('O prazo para envio de evidências foi encerrado.');
      }
      await client.query(
        `INSERT INTO offer_dispute_evidence
          (tenant_id, dispute_id, evidence_type, content, submitted_by_user_id, submitted_by_role)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [auth.tenantId, disputeId, input.evidenceType, input.content, auth.userId, auth.role],
      );
      await appendDisputeEvent(client, auth, disputeId, 'EVIDENCE_ADDED', { evidenceType: input.evidenceType });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'offer.dispute.evidence.added', entityType: 'offer_dispute', entityId: disputeId,
        afterData: { evidenceType: input.evidenceType }, ...(ip ? { ip } : {}) });
      return { body: await loadDispute(client, auth, disputeId), statusCode: 200 };
    },
  ));
}

export async function startDisputeReview(
  database: Database, auth: AuthContext, key: string, disputeId: string, ip?: string,
): Promise<IdempotentResult<OfferDisputeView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `offer-dispute.review:${disputeId}`, {}, async () => {
      const dispute = await loadDispute(client, auth, disputeId);
      if (dispute.status !== 'OPEN') throw conflict('Somente disputas abertas podem entrar em análise.');
      await client.query(
        `UPDATE offer_disputes SET status = 'UNDER_REVIEW', review_started_at = now() WHERE id = $1`, [disputeId],
      );
      await appendDisputeEvent(client, auth, disputeId, 'REVIEW_STARTED');
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'offer.dispute.review.started', entityType: 'offer_dispute', entityId: disputeId, ...(ip ? { ip } : {}) });
      return { body: await loadDispute(client, auth, disputeId), statusCode: 200 };
    },
  ));
}

export async function resolveOfferDispute(
  database: Database, auth: AuthContext, key: string, disputeId: string,
  input: { outcome: DisputeOutcome; resolutionNotes: string }, ip?: string,
): Promise<IdempotentResult<OfferDisputeView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `offer-dispute.resolve:${disputeId}`, input, async () => {
      const dispute = await loadDispute(client, auth, disputeId);
      if (dispute.status === 'RESOLVED') throw conflict('A disputa já foi resolvida.');
      await client.query(
        `UPDATE offer_disputes SET status = 'RESOLVED', outcome = $2, resolution_notes = $3,
           resolved_by_user_id = $4, resolved_at = now() WHERE id = $1`,
        [disputeId, input.outcome, input.resolutionNotes, auth.userId],
      );
      await appendDisputeEvent(client, auth, disputeId, 'DISPUTE_RESOLVED', { outcome: input.outcome });
      await client.query(
        `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'offer_dispute', $2, 'offer.dispute.resolved', $3::jsonb)`,
        [auth.tenantId, disputeId, JSON.stringify({ offerId: dispute.offerId, outcome: input.outcome })],
      );
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'offer.dispute.resolved', entityType: 'offer_dispute', entityId: disputeId,
        beforeData: { status: dispute.status }, afterData: input, ...(ip ? { ip } : {}) });
      return { body: await loadDispute(client, auth, disputeId), statusCode: 200 };
    },
  ));
}

interface ReputationRow {
  courierId: string; courierName: string; storeIds: string[]; eligibleStoreIds: string[];
  notifiedCount: number | string; acceptedCount: number | string; completedCount: number | string;
  courierCancelledCount: number | string; onTimeCount: number | string; punctualitySampleCount: number | string;
  activeBlocks: MarketplaceBlockView[];
}

export async function listCourierReputation(
  database: Database, auth: AuthContext,
): Promise<{ data: CourierReputationView[]; rules: CourierReputationView['thresholds'] }> {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query<ReputationRow>(
      `WITH accessible AS (
         SELECT profile.id, courier_user.name, array_agg(DISTINCT link.store_id) AS store_ids
         FROM courier_profiles profile
         JOIN users courier_user ON courier_user.id = profile.user_id
         JOIN courier_store_links link ON link.courier_profile_id = profile.id AND link.tenant_id = $1 AND link.status = 'ACTIVE'
         WHERE profile.status = 'ACTIVE' AND ($2::text = 'TENANT_MANAGER'
           OR ($2::text = 'STORE_OPERATOR' AND link.store_id = ANY($3::uuid[]))
           OR ($2::text = 'COURIER' AND profile.user_id = $4))
         GROUP BY profile.id, courier_user.name
       ), candidate_stats AS (
         SELECT candidate.courier_profile_id, count(*) AS notified_count
         FROM offer_candidates candidate WHERE candidate.tenant_id = $1 GROUP BY candidate.courier_profile_id
       ), offer_stats AS (
         SELECT offer.winner_courier_id AS courier_profile_id,
           count(*) FILTER (WHERE offer.status IN ('ACCEPTED', 'COMPLETED', 'CANCELLED')) AS accepted_count,
           count(*) FILTER (WHERE offer.status = 'COMPLETED') AS completed_count,
           count(*) FILTER (WHERE offer.status = 'CANCELLED' AND offer.cancelled_by_role = 'COURIER') AS courier_cancelled_count,
           count(*) FILTER (WHERE offer.status = 'COMPLETED' AND offer.delivery_window_end IS NOT NULL) AS punctuality_sample_count,
           count(*) FILTER (WHERE offer.status = 'COMPLETED' AND offer.delivery_window_end IS NOT NULL
             AND delivery.delivered_at <= offer.delivery_window_end) AS on_time_count
         FROM delivery_offers offer JOIN deliveries delivery ON delivery.id = offer.delivery_id
         WHERE offer.tenant_id = $1 AND offer.winner_courier_id IS NOT NULL GROUP BY offer.winner_courier_id
       )
       SELECT accessible.id AS "courierId", accessible.name AS "courierName",
         accessible.store_ids AS "storeIds",
         ARRAY(SELECT scoped_store FROM unnest(accessible.store_ids) scoped_store
           WHERE courier_is_marketplace_eligible($1, accessible.id, scoped_store)) AS "eligibleStoreIds",
         COALESCE(candidate_stats.notified_count, 0) AS "notifiedCount",
         COALESCE(offer_stats.accepted_count, 0) AS "acceptedCount",
         COALESCE(offer_stats.completed_count, 0) AS "completedCount",
         COALESCE(offer_stats.courier_cancelled_count, 0) AS "courierCancelledCount",
         COALESCE(offer_stats.on_time_count, 0) AS "onTimeCount",
         COALESCE(offer_stats.punctuality_sample_count, 0) AS "punctualitySampleCount",
         COALESCE((SELECT json_agg(json_build_object('id', block.id, 'storeId', block.store_id,
           'storeName', store.name, 'reason', block.reason, 'activeUntil', block.active_until, 'createdAt', block.created_at)
           ORDER BY block.created_at DESC)
           FROM courier_marketplace_blocks block LEFT JOIN stores store ON store.id = block.store_id
           WHERE block.tenant_id = $1 AND block.courier_profile_id = accessible.id AND block.revoked_at IS NULL
             AND (block.active_until IS NULL OR block.active_until > now())
             AND ($2::text <> 'STORE_OPERATOR' OR block.store_id = ANY($3::uuid[]))), '[]'::json) AS "activeBlocks"
       FROM accessible LEFT JOIN candidate_stats ON candidate_stats.courier_profile_id = accessible.id
       LEFT JOIN offer_stats ON offer_stats.courier_profile_id = accessible.id ORDER BY accessible.name`,
      [auth.tenantId, auth.role, auth.storeIds, auth.userId],
    );
    const rules = { minimumSample: 5, completionRate: 0.8, punctualityRate: 0.7 };
    return { data: result.rows.map((row) => {
      const notifiedCount = Number(row.notifiedCount); const acceptedCount = Number(row.acceptedCount);
      const completedCount = Number(row.completedCount); const courierCancelledCount = Number(row.courierCancelledCount);
      const onTimeCount = Number(row.onTimeCount); const punctualitySampleCount = Number(row.punctualitySampleCount);
      const accountable = completedCount + courierCancelledCount;
      const acceptanceRate = notifiedCount ? acceptedCount / notifiedCount : null;
      const completionRate = accountable ? completedCount / accountable : null;
      const cancellationRate = accountable ? courierCancelledCount / accountable : null;
      const punctualityRate = punctualitySampleCount ? onTimeCount / punctualitySampleCount : null;
      const reasons = row.activeBlocks.map((block) => `Bloqueio ativo: ${block.reason}`);
      if (accountable >= rules.minimumSample && (completionRate ?? 0) < rules.completionRate) {
        reasons.push(`Conclusão abaixo de 80% (${Math.round((completionRate ?? 0) * 100)}%).`);
      }
      if (punctualitySampleCount >= rules.minimumSample && (punctualityRate ?? 0) < rules.punctualityRate) {
        reasons.push(`Pontualidade abaixo de 70% (${Math.round((punctualityRate ?? 0) * 100)}%).`);
      }
      if (!row.eligibleStoreIds.length && !reasons.length) reasons.push('Sem loja elegível no vínculo atual.');
      return { courierId: row.courierId, courierName: row.courierName, storeIds: row.storeIds,
        eligibleStoreIds: row.eligibleStoreIds, eligible: row.eligibleStoreIds.length > 0, eligibilityReasons: reasons,
        notifiedCount, acceptedCount, completedCount, courierCancelledCount, onTimeCount, punctualitySampleCount,
        acceptanceRate, completionRate, cancellationRate, punctualityRate, activeBlocks: row.activeBlocks, thresholds: rules };
    }), rules };
  });
}

export async function createMarketplaceBlock(
  database: Database, auth: AuthContext, key: string,
  input: { courierId: string; storeId?: string | null | undefined; reason: string;
    activeUntil?: Date | null | undefined }, ip?: string,
): Promise<IdempotentResult<{ id: string }>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, 'courier-marketplace-block.create', input, async () => {
      if (auth.role === 'STORE_OPERATOR' && (!input.storeId || !auth.storeIds.includes(input.storeId))) {
        throw forbidden('O operador só pode bloquear entregadores em suas lojas.');
      }
      const link = await client.query(
        `SELECT 1 FROM courier_store_links WHERE tenant_id = $1 AND courier_profile_id = $2 AND status = 'ACTIVE'
         AND ($3::uuid IS NULL OR store_id = $3) LIMIT 1`, [auth.tenantId, input.courierId, input.storeId ?? null],
      );
      if (!link.rowCount) throw notFound('Entregador sem vínculo ativo no escopo informado.');
      const duplicate = await client.query(
        `SELECT 1 FROM courier_marketplace_blocks WHERE tenant_id = $1 AND courier_profile_id = $2
         AND store_id IS NOT DISTINCT FROM $3::uuid AND revoked_at IS NULL
         AND (active_until IS NULL OR active_until > now()) LIMIT 1`, [auth.tenantId, input.courierId, input.storeId ?? null],
      );
      if (duplicate.rowCount) throw conflict('Já existe um bloqueio ativo neste escopo.');
      const created = await client.query<{ id: string }>(
        `INSERT INTO courier_marketplace_blocks
          (tenant_id, courier_profile_id, store_id, reason, active_until, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [auth.tenantId, input.courierId, input.storeId ?? null, input.reason, input.activeUntil ?? null, auth.userId],
      );
      const id = created.rows[0]!.id;
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'courier.marketplace.blocked', entityType: 'courier_marketplace_block', entityId: id,
        afterData: input, ...(ip ? { ip } : {}) });
      return { body: { id }, statusCode: 201 };
    },
  ));
}

export async function revokeMarketplaceBlock(
  database: Database, auth: AuthContext, key: string, blockId: string, reason: string, ip?: string,
): Promise<IdempotentResult<{ revoked: boolean }>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `courier-marketplace-block.revoke:${blockId}`, { reason }, async () => {
      const block = await client.query<{ store_id: string | null; revoked_at: Date | null }>(
        'SELECT store_id, revoked_at FROM courier_marketplace_blocks WHERE id = $1 FOR UPDATE', [blockId],
      );
      const current = block.rows[0];
      if (!current) throw notFound('Bloqueio não encontrado.');
      if (auth.role === 'STORE_OPERATOR' && (!current.store_id || !auth.storeIds.includes(current.store_id))) {
        throw forbidden('Você não administra este bloqueio.');
      }
      if (current.revoked_at) throw conflict('O bloqueio já foi revogado.');
      await client.query(
        `UPDATE courier_marketplace_blocks SET revoked_at = now(), revoked_by_user_id = $2, revoke_reason = $3 WHERE id = $1`,
        [blockId, auth.userId, reason],
      );
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'courier.marketplace.block.revoked', entityType: 'courier_marketplace_block', entityId: blockId,
        afterData: { reason }, ...(ip ? { ip } : {}) });
      return { body: { revoked: true }, statusCode: 200 };
    },
  ));
}
