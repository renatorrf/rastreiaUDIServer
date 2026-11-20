import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
import { AppError } from '../../shared/errors.js';
import {stoppedRecipients} from './retention-whatsapp.js';

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
  biz_opaque_callback_data?: string;
  phoneNumberId?: string;
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
          const phoneNumberId = (value as {metadata?:{phone_number_id?:string}}).metadata?.phone_number_id;
          found.push({...status,phoneNumberId} as WhatsAppStatus);
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
       WHERE channel='WHATSAPP' AND (provider_message_id = $1
         OR (purpose='DELIVERY_STARTED' AND id::text=$2 AND provider_message_id IS NULL
           AND attempt_count>0 AND status IN ('PROCESSING','UNKNOWN')))
         AND (provider_phone_number_id IS NULL OR provider_phone_number_id=$3)
       LIMIT 1 FOR UPDATE`, [item.id,item.biz_opaque_callback_data ?? '',item.phoneNumberId ?? ''],
    );
    const row = message.rows[0];
    if (!row || !['sent','delivered','read','failed'].includes(item.status)) return;
    await client.query(`UPDATE rastreia.message_deliveries SET provider_message_id=COALESCE(provider_message_id,$2) WHERE id=$1`,[row.id,item.id]);
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
        `UPDATE rastreia.message_deliveries SET status = 'SENT', sent_at = COALESCE(sent_at, now()),
          last_error_code=NULL,last_error_message=NULL WHERE id = $1 AND status NOT IN ('DELIVERED','FAILED')`,
        [row.id],
      );
    } else if (item.status === 'delivered' || item.status === 'read') {
      await client.query(
        `UPDATE rastreia.message_deliveries
         SET status = 'DELIVERED', sent_at = COALESCE(sent_at, now()), delivered_at = COALESCE(delivered_at, now()),
             last_error_code=NULL,last_error_message=NULL
         WHERE id = $1`, [row.id],
      );
    } else if (item.status === 'failed') {
      await client.query(
        `UPDATE rastreia.message_deliveries
         SET status = 'FAILED', failed_at = now(), last_error_code = $2,
             last_error_message = 'O provedor informou falha definitiva.' WHERE id = $1 AND status<>'DELIVERED'`,
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
    for(const phone of stoppedRecipients(request.body,env.WHATSAPP_PHONE_NUMBER_ID)){
      if(!signatureValid(raw,request.headers['x-hub-signature-256'] as string|undefined,env.WHATSAPP_APP_SECRET))
        throw new AppError(401,'WEBHOOK_SIGNATURE_INVALID','Assinatura inválida.');
      await withTransaction(database,async c=>{
        await c.query("SELECT pg_advisory_xact_lock(hashtext('retention-phone:'||$1))",[phone]);
        await c.query('INSERT INTO rastreia.retention_whatsapp_stops(phone_key) VALUES($1) ON CONFLICT DO NOTHING',[phone]);
        await c.query('UPDATE rastreia.retention_preferences SET enabled=false,updated_at=now() WHERE whatsapp=$1 AND enabled',[phone]);
      });
    }
    for (const item of statuses(request.body)) await applyStatus(database, item, payloadHash);
    return reply.send({ received: true });
  });
}
