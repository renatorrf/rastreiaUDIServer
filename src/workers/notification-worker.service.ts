import { createHash } from 'node:crypto';
import webpush from 'web-push';
import type { AppEnv } from '../config/env.js';
import type { Database } from '../database/pool.js';
import { withTransaction } from '../database/pool.js';
import { decryptPayload } from '../shared/encrypted-payload.js';

interface OutboxEvent {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  occurred_at: Date;
}

interface SensitiveMessagePayload {
  whatsappTo: string;
  smsTo: string;
  trackingUrl: string;
  storeName: string;
  reference: string | null;
}

interface MessageRow {
  id: string;
  tenant_id: string;
  delivery_id: string;
  channel: 'WHATSAPP' | 'SMS';
  status: string;
  encrypted_payload: string;
  attempt_count: number;
}

interface ProviderResult { messageId: string; statusCode: number }

class ProviderError extends Error {
  constructor(readonly code: string, readonly statusCode?: number) {
    super(code);
  }
}

function payloadSecret(env: AppEnv): string {
  return env.MESSAGE_PAYLOAD_SECRET || env.TRACKING_TOKEN_PEPPER;
}

function masked(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length > 4 ? `****${digits.slice(-4)}` : '****';
}

function smsConfigured(env: AppEnv): boolean {
  return env.COMMUNICATIONS_MOCK
    || (env.SMS_PROVIDER === 'webhook' && Boolean(env.SMS_API_URL && env.SMS_API_KEY));
}

async function sendWhatsApp(env: AppEnv, payload: SensitiveMessagePayload): Promise<ProviderResult> {
  if (env.COMMUNICATIONS_MOCK) return { messageId: `mock-wa-${crypto.randomUUID()}`, statusCode: 200 };
  const response = await fetch(
    `https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: payload.whatsappTo.replace(/\D/g, ''),
        type: 'template',
        template: {
          name: env.WHATSAPP_TRACKING_TEMPLATE,
          language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE },
          components: [{ type: 'body', parameters: [{ type: 'text', text: payload.trackingUrl }] }],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body = await response.json().catch(() => ({})) as { messages?: Array<{ id?: string }> };
  if (!response.ok) throw new ProviderError('WHATSAPP_REJECTED', response.status);
  const messageId = body.messages?.[0]?.id;
  if (!messageId) throw new ProviderError('WHATSAPP_RESPONSE_INVALID', response.status);
  return { messageId, statusCode: response.status };
}

async function sendSms(env: AppEnv, payload: SensitiveMessagePayload): Promise<ProviderResult> {
  if (env.COMMUNICATIONS_MOCK) return { messageId: `mock-sms-${crypto.randomUUID()}`, statusCode: 200 };
  if (!env.SMS_API_URL) throw new ProviderError('SMS_NOT_CONFIGURED');
  const response = await fetch(env.SMS_API_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.SMS_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      to: payload.smsTo,
      message: `${payload.storeName}: acompanhe sua entrega${payload.reference ? ` ${payload.reference}` : ''} em ${payload.trackingUrl}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({})) as { id?: string; messageId?: string };
  if (!response.ok) throw new ProviderError('SMS_REJECTED', response.status);
  return { messageId: body.id ?? body.messageId ?? `sms-${crypto.randomUUID()}`, statusCode: response.status };
}

async function claimEvent(
  database: Database,
  workerId: string,
  leaseSeconds: number,
): Promise<OutboxEvent | undefined> {
  return withTransaction(database, async (client) => {
    const result = await client.query<OutboxEvent>(
      `UPDATE outbox_events
       SET attempts = attempts + 1,
           available_at = now() + ($2::text || ' seconds')::interval,
           locked_at = now(), locked_by = $1
       WHERE id = (
         SELECT id FROM outbox_events
         WHERE processed_at IS NULL AND available_at <= now()
         ORDER BY occurred_at
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id, tenant_id, aggregate_type, aggregate_id, event_type,
                 payload, attempts, occurred_at`,
      [workerId, leaseSeconds],
    );
    return result.rows[0];
  });
}

async function markProcessed(database: Database, eventId: string): Promise<void> {
  await database.query(
    `UPDATE rastreia.outbox_events
     SET processed_at = now(), last_error = NULL, locked_at = NULL, locked_by = NULL
     WHERE id = $1`, [eventId],
  );
}

export function retryDelaySeconds(
  attempt: number,
  eventId: string,
  baseSeconds: number,
  maxSeconds: number,
): number {
  const exponential = Math.min(maxSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1));
  const digest = createHash('sha256').update(`${eventId}:${attempt}`).digest();
  const jitter = digest.readUInt16BE(0) / 65_535 * 0.25;
  return Math.min(maxSeconds, Math.max(1, Math.round(exponential * (1 + jitter))));
}

async function markRetry(
  database: Database,
  env: AppEnv,
  event: OutboxEvent,
  code: string,
): Promise<boolean> {
  const terminal = event.attempts >= env.OUTBOX_MAX_ATTEMPTS;
  const errorCode = code.slice(0, 200);
  const delaySeconds = retryDelaySeconds(
    event.attempts, event.id, env.OUTBOX_RETRY_BASE_SECONDS, env.OUTBOX_RETRY_MAX_SECONDS,
  );
  await withTransaction(database, async (client) => {
    if (terminal) {
      await client.query(
        `INSERT INTO rastreia.outbox_dead_letters
           (original_event_id, tenant_id, aggregate_type, aggregate_id, event_type,
            payload, attempts, last_error, failed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (original_event_id) DO UPDATE SET
           attempts = EXCLUDED.attempts, last_error = EXCLUDED.last_error,
           failed_at = EXCLUDED.failed_at, updated_at = now()`,
        [event.id, event.tenant_id, event.aggregate_type, event.aggregate_id,
          event.event_type, event.payload, event.attempts, errorCode],
      );
    }
    await client.query(
      `UPDATE rastreia.outbox_events
       SET processed_at = CASE WHEN $2 THEN now() ELSE NULL END,
           dead_lettered_at = CASE WHEN $2 THEN now() ELSE NULL END,
           available_at = CASE WHEN $2 THEN available_at
             ELSE now() + ($4::text || ' seconds')::interval END,
           last_error = $3, locked_at = NULL, locked_by = NULL
       WHERE id = $1`,
      [event.id, terminal, errorCode, delaySeconds],
    );
    if (terminal && event.event_type === 'communication.tracking.requested') {
      await client.query(
        `UPDATE rastreia.message_deliveries
         SET status = 'FAILED', failed_at = now(), last_error_code = $2,
             last_error_message = 'O provedor não confirmou o envio após as tentativas configuradas.'
         WHERE id = $1`,
        [event.aggregate_id, code.slice(0, 100)],
      );
    }
  });
  return terminal;
}

async function processMessage(database: Database, env: AppEnv, event: OutboxEvent): Promise<void> {
  const result = await database.query<MessageRow>(
    `SELECT id, tenant_id, delivery_id, channel, status, encrypted_payload, attempt_count
     FROM rastreia.message_deliveries WHERE id = $1`,
    [event.aggregate_id],
  );
  const message = result.rows[0];
  if (!message || ['SENT', 'DELIVERED'].includes(message.status)) return;
  const payload = decryptPayload<SensitiveMessagePayload>(message.encrypted_payload, payloadSecret(env));
  const attempt = message.attempt_count + 1;
  await database.query(
    `UPDATE rastreia.message_deliveries SET status = 'PROCESSING', attempt_count = $2 WHERE id = $1`,
    [message.id, attempt],
  );
  try {
    const provider = message.channel === 'WHATSAPP'
      ? await sendWhatsApp(env, payload)
      : await sendSms(env, payload);
    await withTransaction(database, async (client) => {
      await client.query(
        `UPDATE rastreia.message_deliveries
         SET status = 'SENT', provider_message_id = $2, sent_at = now(),
             last_error_code = NULL, last_error_message = NULL
         WHERE id = $1`,
        [message.id, provider.messageId],
      );
      await client.query(
        `INSERT INTO rastreia.notification_attempts
           (tenant_id, channel, message_delivery_id, attempt_number, success,
            provider_status, provider_message_id)
         VALUES ($1, $2, $3, $4, true, $5, $6)`,
        [message.tenant_id, message.channel, message.id, attempt, provider.statusCode, provider.messageId],
      );
    });
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : new ProviderError('PROVIDER_UNAVAILABLE');
    const fallback = message.channel === 'WHATSAPP' && smsConfigured(env);
    await withTransaction(database, async (client) => {
      await client.query(
        `INSERT INTO rastreia.notification_attempts
           (tenant_id, channel, message_delivery_id, attempt_number, success,
            provider_status, error_code, error_message)
         VALUES ($1, $2, $3, $4, false, $5, $6, $7)`,
        [message.tenant_id, message.channel, message.id, attempt, providerError.statusCode ?? null,
          providerError.code, 'O provedor não confirmou o envio.'],
      );
      await client.query(
        `UPDATE rastreia.message_deliveries
         SET channel = CASE WHEN $2 THEN 'SMS'::rastreia.notification_channel ELSE channel END,
             destination_masked = CASE WHEN $2 THEN $3 ELSE destination_masked END,
             status = 'RETRYING', next_attempt_at = now(),
             last_error_code = $4, last_error_message = 'O provedor não confirmou o envio.'
         WHERE id = $1`,
        [message.id, fallback, masked(payload.smsTo), providerError.code],
      );
    });
    throw providerError;
  }
}

function pushCopy(eventType: string): { title: string; body: string } | null {
  const copy: Record<string, { title: string; body: string }> = {
    'delivery.assigned': { title: 'Nova entrega atribuída', body: 'Uma entrega está aguardando sua coleta.' },
    'delivery.collect': { title: 'Coleta confirmada', body: 'A entrega coletada está pronta para iniciar o trajeto.' },
    'delivery.start': { title: 'Trajeto iniciado', body: 'O compartilhamento de localização já pode ser ativado.' },
    'delivery.complete': { title: 'Entrega concluída', body: 'A conclusão foi registrada na operação.' },
    'delivery.fail': { title: 'Ocorrência registrada', body: 'A falha da entrega foi registrada.' },
    'shift.available': { title: 'Novo turno disponível', body: 'Uma vaga compatível com sua loja foi aberta.' },
    'shift.filled': { title: 'Turno confirmado', body: 'Sua participação no turno foi confirmada.' },
    'shift.checkin': { title: 'Check-in confirmado', body: 'Seu turno está ativo.' },
    'shift.checkout': { title: 'Turno encerrado', body: 'Seu check-out foi registrado.' },
    'shift.search.wave': { title: 'Busca de cobertura na sua região', body: 'Uma vaga urgente está disponível por tempo limitado.' },
    'shift.confirmation.requested': { title: 'Confirme seu próximo turno', body: 'Precisamos saber se você estará presente.' },
    'shift.reminder': { title: 'Seu turno está próximo', body: 'Confira o horário e programe sua chegada para o check-in.' },
    'shift.cancelled': { title: 'Turno cancelado', body: 'A operação cancelou uma das suas vagas de turno.' },
    'offer.published': { title: 'Nova corrida avulsa', body: 'Uma oferta compatível está disponível por tempo limitado.' },
    'offer.accepted': { title: 'Oferta encerrada', body: 'A corrida já possui um entregador responsável.' },
    'offer.expired': { title: 'Oferta expirada', body: 'O prazo para aceitar esta corrida terminou.' },
    'offer.price.revised': { title: 'Valor da corrida atualizado', body: 'Confira o novo valor antes do prazo terminar.' },
    'offer.cancelled': { title: 'Corrida cancelada', body: 'A oferta foi cancelada e não está mais disponível.' },
    'offer.completed': { title: 'Corrida concluída', body: 'O ganho desta corrida foi registrado no seu extrato.' },
  };
  return copy[eventType] ?? null;
}

async function processPush(database: Database, env: AppEnv, event: OutboxEvent): Promise<void> {
  const copy = pushCopy(event.event_type);
  if (!copy || !env.PUSH_VAPID_SUBJECT || !env.PUSH_VAPID_PUBLIC_KEY || !env.PUSH_VAPID_PRIVATE_KEY) return;
  const shiftEvent = event.event_type.startsWith('shift.');
  const offerEvent = event.event_type.startsWith('offer.');
  const searchWave = event.event_type === 'shift.search.wave';
  const waveId = typeof event.payload['waveId'] === 'string' ? event.payload['waveId'] : null;
  const result = await database.query<{
    id: string; endpoint: string; p256dh: string; auth_secret: string; user_id: string;
  }>(offerEvent
    ? `SELECT DISTINCT subscription.id, subscription.endpoint, subscription.p256dh,
              subscription.auth_secret, subscription.user_id
       FROM rastreia.offer_candidates candidate
       JOIN rastreia.courier_profiles courier ON courier.id = candidate.courier_profile_id
       JOIN rastreia.push_subscriptions subscription
         ON subscription.tenant_id = candidate.tenant_id AND subscription.user_id = courier.user_id
       WHERE candidate.offer_id = $1 AND candidate.tenant_id = $2 AND subscription.active`
    : searchWave
    ? `SELECT subscription.id, subscription.endpoint, subscription.p256dh,
              subscription.auth_secret, subscription.user_id
       FROM rastreia.shift_search_candidates candidate
       JOIN rastreia.courier_profiles courier ON courier.id = candidate.courier_profile_id
       JOIN rastreia.push_subscriptions subscription
         ON subscription.tenant_id = candidate.tenant_id AND subscription.user_id = courier.user_id
       WHERE candidate.wave_id = $1 AND candidate.tenant_id = $2
         AND candidate.status = 'NOTIFIED' AND subscription.active`
    : shiftEvent
    ? `SELECT DISTINCT subscription.id, subscription.endpoint, subscription.p256dh,
              subscription.auth_secret, subscription.user_id
       FROM rastreia.shift_positions position
       JOIN rastreia.shift_slots slot ON slot.id = position.slot_id
       JOIN rastreia.courier_profiles courier
         ON (($3 = 'shift.available' AND EXISTS (
               SELECT 1 FROM rastreia.courier_store_links link
               WHERE link.tenant_id = position.tenant_id AND link.store_id = slot.store_id
                 AND link.courier_profile_id = courier.id AND link.status = 'ACTIVE'
             ))
             OR ($3 <> 'shift.available' AND courier.id = position.assigned_courier_id))
       JOIN rastreia.push_subscriptions subscription
         ON subscription.tenant_id = position.tenant_id AND subscription.user_id = courier.user_id
       WHERE position.id = $1 AND position.tenant_id = $2 AND subscription.active
         AND courier.status = 'ACTIVE'`
    : `SELECT subscription.id, subscription.endpoint, subscription.p256dh,
              subscription.auth_secret, subscription.user_id
       FROM rastreia.deliveries delivery
       JOIN rastreia.courier_profiles courier ON courier.id = delivery.courier_profile_id
       JOIN rastreia.push_subscriptions subscription
         ON subscription.tenant_id = delivery.tenant_id AND subscription.user_id = courier.user_id
       WHERE delivery.id = $1 AND delivery.tenant_id = $2 AND subscription.active`,
    offerEvent
      ? [event.aggregate_id, event.tenant_id]
      : searchWave
      ? [waveId, event.tenant_id]
      : shiftEvent
      ? [event.aggregate_id, event.tenant_id, event.event_type]
      : [event.aggregate_id, event.tenant_id],
  );
  const openUrl = offerEvent ? '/app/ofertas' : shiftEvent ? '/app/turnos' : '/app/entregas';
  for (const subscription of result.rows) {
    try {
      const response = await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth_secret },
      }, JSON.stringify({
        notification: {
          title: copy.title, body: copy.body,
          icon: env.PUSH_NOTIFICATION_ICON_URL || undefined,
          badge: env.PUSH_NOTIFICATION_BADGE_URL || undefined,
          data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen',
            url: `${env.PUSH_APP_URL || env.PUSH_DEFAULT_OPEN_URL}${openUrl}` } } },
        },
      }), {
        vapidDetails: {
          subject: env.PUSH_VAPID_SUBJECT,
          publicKey: env.PUSH_VAPID_PUBLIC_KEY,
          privateKey: env.PUSH_VAPID_PRIVATE_KEY,
        },
        TTL: 300,
        urgency: 'high',
        topic: createHash('sha256').update(`${event.aggregate_id}:${event.event_type}`).digest('base64url').slice(0, 32),
      });
      await withTransaction(database, async (client) => {
        await client.query(
          `UPDATE rastreia.push_subscriptions
           SET last_success_at = now(), failure_count = 0 WHERE id = $1`, [subscription.id],
        );
        await client.query(
          `INSERT INTO rastreia.notification_attempts
             (tenant_id, channel, push_subscription_id, attempt_number, success, provider_status)
           VALUES ($1, 'WEB_PUSH', $2, $3, true, $4)`,
          [event.tenant_id, subscription.id, event.attempts, response.statusCode],
        );
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      const invalid = statusCode === 404 || statusCode === 410;
      await withTransaction(database, async (client) => {
        await client.query(
          `UPDATE rastreia.push_subscriptions
           SET active = CASE WHEN $2 THEN false ELSE active END,
               last_failure_at = now(), failure_count = failure_count + 1
           WHERE id = $1`, [subscription.id, invalid],
        );
        await client.query(
          `INSERT INTO rastreia.notification_attempts
             (tenant_id, channel, push_subscription_id, attempt_number, success,
              provider_status, error_code, error_message)
           VALUES ($1, 'WEB_PUSH', $2, $3, false, $4, $5, 'O serviço push não confirmou o envio.')`,
          [event.tenant_id, subscription.id, event.attempts, statusCode ?? null,
            invalid ? 'SUBSCRIPTION_INVALID' : 'PUSH_UNAVAILABLE'],
        );
      });
      if (!invalid) throw new ProviderError('PUSH_UNAVAILABLE', statusCode);
    }
  }
}

async function processEvent(database: Database, env: AppEnv, event: OutboxEvent): Promise<void> {
  if (event.event_type === 'communication.tracking.requested') await processMessage(database, env, event);
  else if (event.event_type.startsWith('delivery.') || event.event_type.startsWith('shift.')
      || event.event_type.startsWith('offer.')) {
    await processPush(database, env, event);
  }
}

export async function processNotificationBatch(
  database: Database,
  env: AppEnv,
  limit = 25,
  workerId = `${process.pid}:${crypto.randomUUID()}`,
): Promise<{ processed: number; retried: number; deadLettered: number }> {
  let processed = 0;
  let retried = 0;
  let deadLettered = 0;
  for (let index = 0; index < limit; index += 1) {
    const event = await claimEvent(database, workerId, env.OUTBOX_LEASE_SECONDS);
    if (!event) break;
    try {
      await processEvent(database, env, event);
      await markProcessed(database, event.id);
      processed += 1;
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : 'NOTIFICATION_WORKER_ERROR';
      const terminal = await markRetry(database, env, event, code);
      if (terminal) deadLettered += 1;
      else retried += 1;
    }
  }
  return { processed, retried, deadLettered };
}
