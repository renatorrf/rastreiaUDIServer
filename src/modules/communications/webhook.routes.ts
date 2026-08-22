import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
import { AppError } from '../../shared/errors.js';

const verificationSchema = z.object({
  'hub.mode': z.string(),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string(),
});

interface WhatsAppStatus {
  id: string;
  status: string;
  timestamp?: string;
  errors?: Array<{ code?: number | string }>;
}

function signatureValid(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature?.startsWith('sha256=') || !secret) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function statuses(payload: unknown): WhatsAppStatus[] {
  if (!payload || typeof payload !== 'object') return [];
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return [];
  const found: WhatsAppStatus[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const value = (change as { value?: unknown }).value;
      if (!value || typeof value !== 'object') continue;
      const candidates = (value as { statuses?: unknown }).statuses;
      if (!Array.isArray(candidates)) continue;
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const status = candidate as Partial<WhatsAppStatus>;
        if (typeof status.id === 'string' && typeof status.status === 'string') {
          found.push(status as WhatsAppStatus);
        }
      }
    }
  }
  return found;
}

async function applyStatus(database: Database, item: WhatsAppStatus, payloadHash: string): Promise<void> {
  await withTransaction(database, async (client) => {
    const message = await client.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM rastreia.message_deliveries
       WHERE provider_message_id = $1 LIMIT 1 FOR UPDATE`, [item.id],
    );
    const row = message.rows[0];
    if (!row) return;
    const eventId = `${item.id}:${item.status}:${item.timestamp ?? ''}`;
    const receipt = await client.query(
      `INSERT INTO rastreia.message_webhook_receipts
         (tenant_id, provider, provider_event_id, payload_hash)
       VALUES ($1, 'WHATSAPP', $2, $3)
       ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
      [row.tenant_id, eventId, payloadHash],
    );
    if (!receipt.rowCount) return;
    if (item.status === 'sent') {
      await client.query(
        `UPDATE rastreia.message_deliveries SET status = 'SENT', sent_at = COALESCE(sent_at, now()) WHERE id = $1`,
        [row.id],
      );
    } else if (item.status === 'delivered' || item.status === 'read') {
      await client.query(
        `UPDATE rastreia.message_deliveries
         SET status = 'DELIVERED', sent_at = COALESCE(sent_at, now()), delivered_at = COALESCE(delivered_at, now())
         WHERE id = $1`, [row.id],
      );
    } else if (item.status === 'failed') {
      await client.query(
        `UPDATE rastreia.message_deliveries
         SET status = 'FAILED', failed_at = now(), last_error_code = $2,
             last_error_message = 'O provedor informou falha definitiva.' WHERE id = $1`,
        [row.id, String(item.errors?.[0]?.code ?? 'WHATSAPP_FAILED').slice(0, 100)],
      );
    }
  });
}

export async function communicationWebhookRoutes(
  app: FastifyInstance,
  database: Database,
  env: AppEnv,
): Promise<void> {
  app.get('/webhooks/whatsapp', async (request, reply) => {
    const query = verificationSchema.parse(request.query);
    if (query['hub.mode'] !== 'subscribe' || !env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
        || query['hub.verify_token'] !== env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      throw new AppError(403, 'WEBHOOK_VERIFICATION_FAILED', 'Verificação do webhook recusada.');
    }
    return reply.type('text/plain').send(query['hub.challenge']);
  });

  app.post('/webhooks/whatsapp', { config: { rawBody: true } }, async (request, reply) => {
    const raw = Buffer.isBuffer(request.rawBody)
      ? request.rawBody
      : Buffer.from(typeof request.rawBody === 'string' ? request.rawBody : JSON.stringify(request.body));
    if (!env.COMMUNICATIONS_MOCK
        && !signatureValid(raw, request.headers['x-hub-signature-256'] as string | undefined, env.WHATSAPP_APP_SECRET)) {
      throw new AppError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Assinatura do webhook inválida.');
    }
    const payloadHash = createHash('sha256').update(raw).digest('hex');
    for (const item of statuses(request.body)) await applyStatus(database, item, payloadHash);
    return reply.send({ received: true });
  });
}
