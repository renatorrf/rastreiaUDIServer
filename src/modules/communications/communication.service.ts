import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { encryptPayload } from '../../shared/encrypted-payload.js';
import { AppError, forbidden, notFound } from '../../shared/errors.js';
import { withIdempotency } from '../../shared/idempotency.js';
import type { AuthContext } from '../auth/auth.types.js';
import { generateTrackingToken, trackingTokenHash } from '../tracking/tracking-token.js';

export type CustomerMessageChannel = 'WHATSAPP' | 'SMS';

export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime?: Date | null | undefined;
  keys: { p256dh: string; auth: string };
}

interface DeliveryMessageScope {
  id: string;
  storeId: string;
  storeName: string;
  externalReference: string | null;
  recipientPhone: string;
  recipientWhatsapp: string | null;
  deliveredAt: Date | null;
}

function secret(env: AppEnv): string {
  return env.MESSAGE_PAYLOAD_SECRET || env.TRACKING_TOKEN_PEPPER;
}

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length > 4 ? `****${digits.slice(-4)}` : '****';
}

function publicTrackingUrl(baseUrl: string, token: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base ? `${base}/${token}` : `/rastrear/${token}`;
}

function providerConfigured(env: AppEnv, channel: CustomerMessageChannel): boolean {
  if (env.COMMUNICATIONS_MOCK) return true;
  if (channel === 'WHATSAPP') {
    return Boolean(env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_TRACKING_TEMPLATE);
  }
  return env.SMS_PROVIDER === 'webhook' && Boolean(env.SMS_API_URL && env.SMS_API_KEY);
}

async function loadDeliveryScope(
  client: PoolClient,
  auth: AuthContext,
  deliveryId: string,
): Promise<DeliveryMessageScope> {
  const result = await client.query<{
    id: string; store_id: string; store_name: string; external_reference: string | null;
    recipient_phone: string; recipient_whatsapp: string | null; delivered_at: Date | null;
  }>(
    `SELECT delivery.id, delivery.store_id, store.name AS store_name,
            delivery.external_reference, delivery.recipient_phone,
            delivery.recipient_whatsapp, delivery.delivered_at
     FROM deliveries delivery
     JOIN stores store ON store.id = delivery.store_id
     WHERE delivery.id = $1 AND delivery.tenant_id = $2`,
    [deliveryId, auth.tenantId],
  );
  const row = result.rows[0];
  if (!row) throw notFound('Entrega não encontrada.');
  if (auth.role !== 'TENANT_MANAGER' && !auth.storeIds.includes(row.store_id)) {
    throw forbidden('Você não possui acesso à loja desta entrega.');
  }
  return {
    id: row.id, storeId: row.store_id, storeName: row.store_name,
    externalReference: row.external_reference, recipientPhone: row.recipient_phone,
    recipientWhatsapp: row.recipient_whatsapp, deliveredAt: row.delivered_at,
  };
}

export async function savePushSubscription(
  database: Database,
  auth: AuthContext,
  input: PushSubscriptionInput,
  userAgent?: string,
) {
  return withTenantTransaction(database, auth, async (client) => {
    const endpointHash = createHash('sha256').update(input.endpoint).digest('hex');
    const result = await client.query<{ id: string }>(
      `INSERT INTO push_subscriptions
         (tenant_id, user_id, endpoint, endpoint_hash, p256dh, auth_secret,
          expiration_time, user_agent, active, failure_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, 0)
       ON CONFLICT (tenant_id, user_id, endpoint_hash) DO UPDATE SET
         endpoint = EXCLUDED.endpoint, p256dh = EXCLUDED.p256dh,
         auth_secret = EXCLUDED.auth_secret, expiration_time = EXCLUDED.expiration_time,
         user_agent = EXCLUDED.user_agent, active = true, failure_count = 0,
         last_failure_at = NULL
       RETURNING id`,
      [auth.tenantId, auth.userId, input.endpoint, endpointHash, input.keys.p256dh,
        input.keys.auth, input.expirationTime ?? null, userAgent ?? null],
    );
    return { id: result.rows[0]!.id, active: true };
  });
}

export async function removePushSubscription(database: Database, auth: AuthContext, endpoint: string) {
  return withTenantTransaction(database, auth, async (client) => {
    const endpointHash = createHash('sha256').update(endpoint).digest('hex');
    const result = await client.query(
      `UPDATE push_subscriptions SET active = false
       WHERE tenant_id = $1 AND user_id = $2 AND endpoint_hash = $3`,
      [auth.tenantId, auth.userId, endpointHash],
    );
    return { removed: Boolean(result.rowCount) };
  });
}

export async function getPushStatus(database: Database, auth: AuthContext, env: AppEnv) {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM push_subscriptions
       WHERE tenant_id = $1 AND user_id = $2 AND active`,
      [auth.tenantId, auth.userId],
    );
    return {
      configured: Boolean(env.PUSH_VAPID_SUBJECT && env.PUSH_VAPID_PUBLIC_KEY && env.PUSH_VAPID_PRIVATE_KEY),
      publicKey: env.PUSH_VAPID_PUBLIC_KEY || null,
      activeDevices: Number(result.rows[0]?.count ?? 0),
    };
  });
}

export async function queueTrackingMessage(
  database: Database,
  env: AppEnv,
  auth: AuthContext,
  key: string,
  deliveryId: string,
  channel: CustomerMessageChannel,
  ip?: string,
) {
  if (!providerConfigured(env, channel)) {
    throw new AppError(503, 'MESSAGE_PROVIDER_NOT_CONFIGURED',
      `O provedor ${channel === 'WHATSAPP' ? 'WhatsApp' : 'SMS'} ainda não foi configurado.`);
  }
  return withTenantTransaction(database, auth, async (client) =>
    withIdempotency(client, auth, key, 'communication.tracking-message', { deliveryId, channel }, async () => {
      const delivery = await loadDeliveryScope(client, auth, deliveryId);
      const destination = channel === 'WHATSAPP'
        ? delivery.recipientWhatsapp ?? delivery.recipientPhone
        : delivery.recipientPhone;
      const token = generateTrackingToken();
      const absoluteExpiry = new Date(Date.now() + env.TRACKING_TOKEN_TTL_SECONDS * 1000);
      const completedExpiry = delivery.deliveredAt
        ? new Date(delivery.deliveredAt.getTime() + env.TRACKING_COMPLETED_GRACE_SECONDS * 1000)
        : null;
      const expiresAt = completedExpiry && completedExpiry < absoluteExpiry ? completedExpiry : absoluteExpiry;
      if (expiresAt <= new Date()) {
        throw new AppError(409, 'TRACKING_WINDOW_CLOSED', 'A janela pública desta entrega já foi encerrada.');
      }

      await client.query(
        `UPDATE tracking_tokens SET revoked_at = now(), revoked_by = $3
         WHERE tenant_id = $1 AND delivery_id = $2 AND revoked_at IS NULL`,
        [auth.tenantId, deliveryId, auth.userId],
      );
      await client.query(
        `INSERT INTO tracking_tokens (tenant_id, delivery_id, token_hash, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [auth.tenantId, deliveryId, trackingTokenHash(token, env.TRACKING_TOKEN_PEPPER), expiresAt, auth.userId],
      );
      const encryptedPayload = encryptPayload({
        whatsappTo: delivery.recipientWhatsapp ?? delivery.recipientPhone,
        smsTo: delivery.recipientPhone,
        trackingUrl: publicTrackingUrl(env.PUBLIC_TRACKING_BASE_URL, token),
        storeName: delivery.storeName,
        reference: delivery.externalReference,
      }, secret(env));
      const message = await client.query<{ id: string }>(
        `INSERT INTO message_deliveries
           (tenant_id, delivery_id, channel, destination_masked, encrypted_payload, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [auth.tenantId, deliveryId, channel, maskPhone(destination), encryptedPayload, auth.userId],
      );
      const messageId = message.rows[0]!.id;
      await client.query(
        `INSERT INTO outbox_events
           (tenant_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'message_delivery', $2, 'communication.tracking.requested', $3::jsonb)`,
        [auth.tenantId, messageId, JSON.stringify({ messageDeliveryId: messageId, deliveryId, channel })],
      );
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'tracking_message.queued',
        entityType: 'delivery', entityId: deliveryId,
        afterData: { messageDeliveryId: messageId, channel, destinationMasked: maskPhone(destination) },
        ...(ip === undefined ? {} : { ip }),
      });
      return {
        statusCode: 202,
        body: { id: messageId, channel, status: 'PENDING', destinationMasked: maskPhone(destination), expiresAt },
      };
    }),
  );
}

export async function listDeliveryMessages(database: Database, auth: AuthContext, deliveryId: string) {
  return withTenantTransaction(database, auth, async (client) => {
    await loadDeliveryScope(client, auth, deliveryId);
    const result = await client.query(
      `SELECT id, channel, status, destination_masked AS "destinationMasked",
              provider_message_id AS "providerMessageId", attempt_count AS "attemptCount",
              sent_at AS "sentAt", delivered_at AS "deliveredAt", failed_at AS "failedAt",
              last_error_code AS "lastErrorCode", last_error_message AS "lastErrorMessage",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM message_deliveries WHERE delivery_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [deliveryId],
    );
    return { data: result.rows };
  });
}
