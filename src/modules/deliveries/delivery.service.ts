import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { withIdempotency, type IdempotentResult } from '../../shared/idempotency.js';
import type { AuthContext } from '../auth/auth.types.js';
import { assertDeliveryTransition, nextOperationalActions } from './delivery-state.js';
import type { DeliveryRecord, DeliveryStatus } from './delivery.types.js';
import { completeOfferForDelivery } from '../offers/offer.service.js';
import { createFailureIncident } from '../incidents/incident.repository.js';

export interface CreateDeliveryInput {
  storeId: string;
  externalReference?: string | null | undefined;
  recipientName: string;
  recipientPhone: string;
  recipientWhatsapp?: string | null | undefined;
  addressLine: string;
  addressNumber?: string | null | undefined;
  complement?: string | null | undefined;
  neighborhood?: string | null | undefined;
  city: string;
  state: string;
  postalCode?: string | null | undefined;
  latitude: number;
  longitude: number;
  addressConfidence?: number | null | undefined;
  deliveryInstructions?: string | null | undefined;
  promisedWindowStart?: Date | null | undefined;
  promisedWindowEnd?: Date | null | undefined;
}

interface ListFilters {
  status?: DeliveryStatus | undefined;
  storeId?: string | undefined;
  limit: number;
}

const deliverySelect = `
  SELECT d.id, d.tenant_id AS "tenantId", d.store_id AS "storeId", store.name AS "storeName",
         d.route_id AS "routeId", d.courier_profile_id AS "courierId", courier_user.name AS "courierName",
         d.external_reference AS "externalReference", d.recipient_name AS "recipientName",
         d.recipient_phone AS "recipientPhone", d.recipient_whatsapp AS "recipientWhatsapp",
         d.address_line AS "addressLine", d.address_number AS "addressNumber", d.complement,
         d.neighborhood, d.city, d.state, d.postal_code AS "postalCode", d.latitude, d.longitude,
         d.address_confidence::float8 AS "addressConfidence",
         d.delivery_instructions AS "deliveryInstructions", d.status,
         d.promised_window_start AS "promisedWindowStart", d.promised_window_end AS "promisedWindowEnd",
         d.collected_at AS "collectedAt", d.out_for_delivery_at AS "outForDeliveryAt",
         d.delivered_at AS "deliveredAt", d.cancelled_at AS "cancelledAt", d.failed_at AS "failedAt",
         d.failure_reason AS "failureReason", d.version,
         d.created_at AS "createdAt", d.updated_at AS "updatedAt"
  FROM deliveries d
  JOIN stores store ON store.id = d.store_id
  LEFT JOIN courier_profiles courier ON courier.id = d.courier_profile_id
  LEFT JOIN users courier_user ON courier_user.id = courier.user_id`;

const accessPredicate = `
  AND (
    $2::text = 'TENANT_MANAGER'
    OR ($2::text = 'STORE_OPERATOR' AND d.store_id = ANY($3::uuid[]))
    OR ($2::text = 'COURIER' AND EXISTS (
      SELECT 1 FROM courier_profiles own_profile
      WHERE own_profile.id = d.courier_profile_id AND own_profile.user_id = $4
    ))
  )`;

function accessParameters(auth: AuthContext): [string, string[], string] {
  return [auth.role, auth.storeIds, auth.userId];
}

function canUseStore(auth: AuthContext, storeId: string): boolean {
  return auth.role === 'TENANT_MANAGER' || (auth.role === 'STORE_OPERATOR' && auth.storeIds.includes(storeId));
}

export async function loadDelivery(
  client: PoolClient,
  auth: AuthContext,
  deliveryId: string,
  lock = false,
): Promise<DeliveryRecord> {
  const result = await client.query<DeliveryRecord>(
    `${deliverySelect} WHERE d.id = $1 ${accessPredicate} ${lock ? 'FOR UPDATE OF d' : ''}`,
    [deliveryId, ...accessParameters(auth)],
  );
  const delivery = result.rows[0];
  if (!delivery) throw notFound('Entrega não encontrada.');
  return delivery;
}

async function appendHistory(
  client: PoolClient,
  auth: AuthContext,
  delivery: DeliveryRecord,
  fromStatus: DeliveryStatus | null,
  reason?: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO delivery_status_history
       (tenant_id, delivery_id, from_status, to_status, reason, metadata, actor_user_id, delivery_version)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [auth.tenantId, delivery.id, fromStatus, delivery.status, reason ?? null,
      JSON.stringify(metadata), auth.userId, delivery.version],
  );
}

async function publishEvent(
  client: PoolClient,
  auth: AuthContext,
  deliveryId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events
       (tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'delivery', $2, $3, $4::jsonb)`,
    [auth.tenantId, deliveryId, eventType, JSON.stringify(payload)],
  );
}

export async function applyTransition(
  client: PoolClient,
  auth: AuthContext,
  delivery: DeliveryRecord,
  target: DeliveryStatus,
  reason?: string,
  metadata: Record<string, unknown> = {},
): Promise<DeliveryRecord> {
  assertDeliveryTransition(delivery.status, target);
  const fromStatus = delivery.status;
  const update = await client.query<{ version: number }>(
    `UPDATE deliveries
     SET status = $3,
         version = version + 1,
         updated_by = $4,
         collected_at = CASE WHEN $3::delivery_status = 'COLLECTED' THEN now() ELSE collected_at END,
         out_for_delivery_at = CASE WHEN $3::delivery_status = 'IN_ROUTE' THEN now() ELSE out_for_delivery_at END,
         delivered_at = CASE WHEN $3::delivery_status = 'DELIVERED' THEN now() ELSE delivered_at END,
         cancelled_at = CASE WHEN $3::delivery_status = 'CANCELLED' THEN now() ELSE cancelled_at END,
         failed_at = CASE WHEN $3::delivery_status = 'DELIVERY_FAILED' THEN now() ELSE failed_at END,
         failure_reason = CASE WHEN $3::delivery_status = 'DELIVERY_FAILED' THEN $5 ELSE failure_reason END
     WHERE id = $1 AND version = $2
     RETURNING version`,
    [delivery.id, delivery.version, target, auth.userId, reason ?? null],
  );
  if (!update.rowCount) throw notFound('A entrega foi alterada por outra operação. Atualize e tente novamente.');

  const changed = { ...delivery, status: target, version: update.rows[0]!.version };
  await appendHistory(client, auth, changed, fromStatus, reason, metadata);
  return changed;
}

async function loadCurrentRecord(client: PoolClient, auth: AuthContext, id: string): Promise<DeliveryRecord> {
  return loadDelivery(client, auth, id);
}

export async function listDeliveries(
  database: Database,
  auth: AuthContext,
  filters: ListFilters,
): Promise<{ data: Array<DeliveryRecord & { nextActions: string[] }> }> {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query<DeliveryRecord>(
      `${deliverySelect}
       WHERE ($1::delivery_status IS NULL OR d.status = $1)
       ${accessPredicate}
       AND ($5::uuid IS NULL OR d.store_id = $5)
       ORDER BY d.created_at DESC
       LIMIT $6`,
      [filters.status ?? null, ...accessParameters(auth), filters.storeId ?? null, filters.limit],
    );
    return { data: result.rows.map((delivery) => ({ ...delivery, nextActions: nextOperationalActions(delivery.status) })) };
  });
}

export async function getDelivery(database: Database, auth: AuthContext, deliveryId: string) {
  return withTenantTransaction(database, auth, async (client) => {
    const delivery = await loadDelivery(client, auth, deliveryId);
    const history = await client.query(
      `SELECT id, from_status AS "fromStatus", to_status AS "toStatus", reason, metadata,
              actor_user_id AS "actorUserId", delivery_version AS version, created_at AS "createdAt"
       FROM delivery_status_history WHERE delivery_id = $1 ORDER BY delivery_version`,
      [deliveryId],
    );
    return { ...delivery, nextActions: nextOperationalActions(delivery.status), history: history.rows };
  });
}

export async function createDelivery(
  database: Database,
  auth: AuthContext,
  key: string,
  input: CreateDeliveryInput,
  ip?: string,
): Promise<IdempotentResult<DeliveryRecord & { nextActions: string[] }>> {
  return withTenantTransaction(database, auth, async (client) =>
    withIdempotency(client, auth, key, 'delivery.create', input, async () => {
      if (!canUseStore(auth, input.storeId)) throw forbidden('Você não possui acesso à loja informada.');
      const store = await client.query('SELECT id FROM stores WHERE id = $1 AND status = \'ACTIVE\'', [input.storeId]);
      if (!store.rowCount) throw notFound('Loja não encontrada.');

      const deliveryId = randomUUID();
      await client.query(
        `INSERT INTO deliveries
           (id, tenant_id, store_id, external_reference, recipient_name, recipient_phone,
            recipient_whatsapp, address_line, address_number, complement, neighborhood,
            city, state, postal_code, latitude, longitude, address_confidence,
            delivery_instructions, status, promised_window_start, promised_window_end,
            created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, $17, $18, 'AWAITING_COURIER', $19, $20, $21, $21)`,
        [deliveryId, auth.tenantId, input.storeId, input.externalReference ?? null,
          input.recipientName, input.recipientPhone, input.recipientWhatsapp ?? null,
          input.addressLine, input.addressNumber ?? null, input.complement ?? null,
          input.neighborhood ?? null, input.city, input.state, input.postalCode ?? null,
          input.latitude, input.longitude, input.addressConfidence ?? null,
          input.deliveryInstructions ?? null, input.promisedWindowStart ?? null,
          input.promisedWindowEnd ?? null, auth.userId],
      );
      const delivery = await loadCurrentRecord(client, auth, deliveryId);
      await appendHistory(client, auth, delivery, null);
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'delivery.created',
        entityType: 'delivery', entityId: deliveryId,
        afterData: { status: delivery.status, storeId: delivery.storeId, externalReference: delivery.externalReference },
        ...(ip === undefined ? {} : { ip }),
      });
      await publishEvent(client, auth, deliveryId, 'delivery.created', { deliveryId, storeId: delivery.storeId, status: delivery.status });
      return { body: { ...delivery, nextActions: nextOperationalActions(delivery.status) }, statusCode: 201 };
    }),
  );
}

export async function assignDelivery(
  database: Database,
  auth: AuthContext,
  key: string,
  deliveryId: string,
  courierId: string,
  ip?: string,
): Promise<IdempotentResult<DeliveryRecord & { nextActions: string[] }>> {
  return withTenantTransaction(database, auth, async (client) =>
    withIdempotency(client, auth, key, 'delivery.assign', { deliveryId, courierId }, async () => {
      let delivery = await loadDelivery(client, auth, deliveryId, true);
      const courier = await client.query(
        `SELECT profile.id
         FROM courier_profiles profile
         JOIN courier_store_links link ON link.courier_profile_id = profile.id
         WHERE profile.id = $1 AND profile.status = 'ACTIVE'
           AND link.tenant_id = $2 AND link.store_id = $3 AND link.status = 'ACTIVE'`,
        [courierId, auth.tenantId, delivery.storeId],
      );
      if (!courier.rowCount) throw notFound('Entregador ativo e vinculado à loja não encontrado.');

      await client.query('UPDATE deliveries SET courier_profile_id = $2, updated_by = $3 WHERE id = $1',
        [delivery.id, courierId, auth.userId]);
      delivery = { ...delivery, courierId };
      delivery = await applyTransition(client, auth, delivery, 'ASSIGNED', undefined, { courierId });
      await applyTransition(client, auth, delivery, 'AWAITING_PICKUP');
      const current = await loadCurrentRecord(client, auth, deliveryId);
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'delivery.assigned',
        entityType: 'delivery', entityId: deliveryId,
        beforeData: { status: 'AWAITING_COURIER', courierId: null },
        afterData: { status: current.status, courierId },
        ...(ip === undefined ? {} : { ip }),
      });
      await publishEvent(client, auth, deliveryId, 'delivery.assigned', { deliveryId, courierId, status: current.status });
      return { body: { ...current, nextActions: nextOperationalActions(current.status) }, statusCode: 200 };
    }),
  );
}

type TransitionAction = 'collect' | 'start' | 'complete' | 'fail' | 'cancel';

const actionTarget: Record<TransitionAction, DeliveryStatus> = {
  collect: 'COLLECTED',
  start: 'IN_ROUTE',
  complete: 'DELIVERED',
  fail: 'DELIVERY_FAILED',
  cancel: 'CANCELLED',
};

export async function transitionDelivery(
  database: Database,
  auth: AuthContext,
  key: string,
  deliveryId: string,
  action: TransitionAction,
  reason?: string,
  ip?: string,
): Promise<IdempotentResult<DeliveryRecord & { nextActions: string[] }>> {
  return withTenantTransaction(database, auth, async (client) =>
    withIdempotency(client, auth, key, `delivery.${action}`, { deliveryId, reason: reason ?? null }, async () => {
      const before = await loadDelivery(client, auth, deliveryId, true);
      if (before.routeId && ['collect', 'start', 'complete'].includes(action)) {
        throw conflict('Esta entrega pertence a um lote. Avance pela prancheta de Rotas.');
      }
      if (action === 'cancel') {
        const marketplace = await client.query(
          `SELECT 1 FROM delivery_offers WHERE delivery_id = $1 AND status IN ('PUBLISHED', 'ACCEPTED')`, [deliveryId],
        );
        if (marketplace.rowCount) throw conflict('Cancele a oferta no Marketplace para aplicar as regras de compensação.');
      }
      const transitioned = await applyTransition(client, auth, before, actionTarget[action], reason);
      if (action === 'fail') {
        await createFailureIncident(client, auth, transitioned, reason!, ip);
      }
      if (action === 'complete') await completeOfferForDelivery(client, auth, deliveryId);
      const current = await loadCurrentRecord(client, auth, deliveryId);
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: `delivery.${action}`,
        entityType: 'delivery', entityId: deliveryId,
        beforeData: { status: before.status, version: before.version },
        afterData: { status: current.status, version: current.version, reason: reason ?? null },
        ...(ip === undefined ? {} : { ip }),
      });
      await publishEvent(client, auth, deliveryId, `delivery.${action}`, { deliveryId, status: current.status, version: current.version });
      return { body: { ...current, nextActions: nextOperationalActions(current.status) }, statusCode: 200 };
    }),
  );
}
