import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import { withTransaction, type Database } from '../../database/pool.js';
import { encryptPayload, decryptPayload } from '../../shared/encrypted-payload.js';
import { AppError } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { generateTrackingToken, trackingTokenHash } from '../tracking/tracking-token.js';

const purpose = 'DELIVERY_STARTED';
const activeStatuses = ['IN_ROUTE', 'NEXT_STOP'];
const secret = (env: AppEnv) => env.MESSAGE_PAYLOAD_SECRET || env.TRACKING_TOKEN_PEPPER;
type Source = 'AUTOMATIC' | 'MANUAL';
interface Delivery {
  id: string; tenant_id: string; company_id: string; store_name: string; status: string;
  recipient_name: string; recipient_phone: string; recipient_whatsapp: string | null;
  external_reference: string | null; courier_profile_id: string | null; out_for_delivery_at: Date | null;
  operation_active: boolean;
}
interface Payload {
  to: string; firstName: string; reference: string; storeName: string; trackingUrl: string;
  appUrl: string; template: string; language: string; companyId: string;
}
interface Notice {
  id: string; tenant_id: string; delivery_id: string; status: string; purpose: string | null;
  trigger_source: Source; encrypted_payload: string; tracking_token_id: string | null;
  provider_phone_number_id: string | null; attempt_count: number;
  destinationMasked: string; lastErrorCode: string | null;
  provider_message_id: string | null;
}

// Do not guess a missing ninth digit or accept iFood relay numbers/extensions.
// The intended recipient must be the exact Brazilian number stored in the order.
export function whatsappRecipient(value: string): string | null {
  let digits = value.replace(/[\s()+.-]/g, '');
  if (/^55\d{10,11}$/.test(digits)) digits = digits.slice(2);
  const ddd = Number(digits.slice(0, 2));
  const validDdd = [11,12,13,14,15,16,17,18,19,21,22,24,27,28,31,32,33,34,35,37,38,41,42,43,44,45,46,47,48,49,51,53,54,55,61,62,63,64,65,66,67,68,69,71,73,74,75,77,79,81,82,83,84,85,86,87,88,89,91,92,93,94,95,96,97,98,99];
  return validDdd.includes(ddd) && /^\d{2}(?:9\d{8}|[2-5]\d{7})$/.test(digits) ? `55${digits}` : null;
}
const recipient = (d: Delivery) => whatsappRecipient(d.recipient_whatsapp?.trim() || d.recipient_phone || '');
const mask = (value: string | null) => value ? `****${value.slice(-4)}` : 'Não informado';
const configured = (env: AppEnv) => Boolean(env.COMMUNICATIONS_MOCK || (env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN));
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
function httpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('WHATSAPP_URL_INVALID');
  return url.toString().replace(/\/+$/, '');
}
export function trackingTemplateBody(payload: Payload, messageId: string) {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to: payload.to, type: 'template',
    biz_opaque_callback_data: messageId,
    template: { name: payload.template, language: { code: payload.language }, components: [{ type: 'body', parameters:
      [payload.firstName, payload.reference, payload.storeName, payload.trackingUrl, payload.appUrl]
        .map(text => ({ type: 'text', text })) }] } };
}
async function delivery(client: Pick<PoolClient, 'query'>, tenantId: string, id: string, lock = false) {
  return (await client.query<Delivery>(`SELECT d.*,s.name AS store_name,
    (s.status='ACTIVE' AND c.status='ACTIVE' AND t.status='ACTIVE') AS operation_active FROM rastreia.deliveries d
    JOIN rastreia.stores s ON s.id=d.store_id AND s.tenant_id=d.tenant_id AND s.company_id=d.company_id
    JOIN rastreia.companies c ON c.id=d.company_id AND c.tenant_id=d.tenant_id
    JOIN rastreia.tenants t ON t.id=d.tenant_id
    WHERE d.id=$1 AND d.tenant_id=$2 ${lock ? 'FOR UPDATE OF d' : ''}`, [id, tenantId])).rows[0];
}
function eligibility(d: Delivery, env: AppEnv, source: Source): string | null {
  if (!d.operation_active) return 'OPERATION_INACTIVE';
  if (!activeStatuses.includes(d.status) || !d.courier_profile_id || !d.out_for_delivery_at) return 'DELIVERY_NOT_IN_ROUTE';
  if (!recipient(d)) return 'RECIPIENT_INVALID';
  if (source === 'AUTOMATIC' && !env.WHATSAPP_AUTOMATIC_TRACKING_ENABLED) return 'AUTOMATIC_DISABLED';
  if (!configured(env)) return 'WHATSAPP_NOT_CONFIGURED';
  return null;
}

export async function queueStartedWhatsApp(client: PoolClient, env: AppEnv,
  input: { tenantId: string; deliveryId: string; source: Source; actorId: string | null; retry?: boolean }) {
  const d = await delivery(client, input.tenantId, input.deliveryId, true);
  if (!d) return null;
  const existing = (await client.query<Notice>(`SELECT *,destination_masked AS "destinationMasked",last_error_code AS "lastErrorCode"
    FROM rastreia.message_deliveries WHERE tenant_id=$1 AND delivery_id=$2 AND channel='WHATSAPP'
    AND (purpose=$3 OR (purpose IS NULL AND status IN ('PENDING','PROCESSING','RETRYING','SENT','DELIVERED')))
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [input.tenantId, d.id, purpose])).rows[0];
  // Retries are only deliberate manual actions after a known rejection/skip.
  if (existing && !(input.source === 'MANUAL' && input.retry && existing.purpose === purpose
    && !existing.provider_message_id && ['FAILED','SKIPPED'].includes(existing.status))) return { id:existing.id,status:existing.status,
      channel:'WHATSAPP',destinationMasked:existing.destinationMasked,lastErrorCode:existing.lastErrorCode,reused:true };
  const blocked = eligibility(d, env, input.source);
  if (blocked && input.source === 'MANUAL') throw new AppError(409, blocked,
    blocked === 'RECIPIENT_INVALID' ? 'Confira o WhatsApp do cliente no pedido.' :
      blocked === 'DELIVERY_NOT_IN_ROUTE' ? 'O aviso de saída só pode ser enviado durante o trajeto da entrega.' : 'Configure o WhatsApp da R3 Labs no servidor.');
  // Disabled means no opt-in to dispatch; do not create or backfill historical messages.
  if (blocked === 'AUTOMATIC_DISABLED') return null;
  let tokenId: string | null = null;
  let payload: Partial<Payload> = {};
  if (!blocked) {
    const token = generateTrackingToken();
    const trackingUrl = `${httpsUrl(env.PUBLIC_TRACKING_BASE_URL)}/${token}`;
    payload = { to: recipient(d)!, firstName: clean(d.recipient_name).split(' ')[0] || 'Cliente',
      reference: clean(d.external_reference || d.id.slice(0, 8)), storeName: clean(d.store_name),
      trackingUrl, appUrl: httpsUrl(env.WHATSAPP_CUSTOMER_APP_URL), companyId: d.company_id,
      template: env.WHATSAPP_DELIVERY_STARTED_TEMPLATE, language: env.WHATSAPP_TEMPLATE_LANGUAGE };
    // A separate valid token; never revoke a link already sent/copied by the store.
    tokenId = (await client.query<{ id: string }>(`INSERT INTO rastreia.tracking_tokens
      (tenant_id,delivery_id,token_hash,expires_at,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [input.tenantId,d.id,trackingTokenHash(token,env.TRACKING_TOKEN_PEPPER),
      new Date(Date.now() + env.TRACKING_TOKEN_TTL_SECONDS * 1000),input.actorId])).rows[0]!.id;
  }
  const values = [input.tenantId,d.id,mask(recipient(d)),encryptPayload(payload,secret(env)),input.actorId,
    purpose,input.source,tokenId,env.WHATSAPP_PHONE_NUMBER_ID || null,blocked ? 'SKIPPED' : 'PENDING',blocked];
  const columns = `id,status,channel,destination_masked AS "destinationMasked",trigger_source AS "triggerSource",last_error_code AS "lastErrorCode"`;
  const message = existing ? (await client.query<{ id: string; status: string }>(`UPDATE rastreia.message_deliveries
    SET encrypted_payload=$4,created_by=$5,trigger_source=$7,tracking_token_id=$8,provider_phone_number_id=$9,
      status=$10::rastreia.message_delivery_status,last_error_code=$11,destination_masked=$3,
      failed_at=NULL,last_error_message=NULL,provider_message_id=NULL
    WHERE tenant_id=$1 AND delivery_id=$2 AND purpose=$6 AND id=$12 RETURNING ${columns}`, [...values,existing.id])).rows[0]!
    : (await client.query<{ id: string; status: string }>(`INSERT INTO rastreia.message_deliveries
      (tenant_id,delivery_id,channel,destination_masked,encrypted_payload,created_by,purpose,trigger_source,
       tracking_token_id,provider_phone_number_id,status,last_error_code)
      VALUES($1,$2,'WHATSAPP',$3,$4,$5,$6,$7,$8,$9,$10::rastreia.message_delivery_status,$11) RETURNING ${columns}`,values)).rows[0]!;
  if (!blocked) await client.query(`INSERT INTO rastreia.outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload)
    VALUES($1,'message_delivery',$2,'communication.tracking.requested',$3::jsonb)`,
  [input.tenantId,message.id,JSON.stringify({messageDeliveryId:message.id,deliveryId:d.id,channel:'WHATSAPP'})]);
  await writeAudit(client,{tenantId:input.tenantId,actorUserId:input.actorId,action:blocked?'tracking_message.skipped':'tracking_message.queued',
    entityType:'delivery',entityId:d.id,afterData:{messageDeliveryId:message.id,source:input.source,reason:blocked,destinationMasked:mask(recipient(d))}});
  return { ...message, reused: false };
}

export async function queueAutomaticStartedWhatsApp(database: Database, env: AppEnv,
  event: { tenant_id: string; aggregate_id: string; event_type: string; occurred_at: Date }) {
  if (event.event_type !== 'delivery.start' || !env.WHATSAPP_AUTOMATIC_TRACKING_ENABLED) return;
  // Do not notify old departures when a stopped worker restarts after an outage.
  const age = Date.now() - new Date(event.occurred_at).getTime();
  if (!Number.isFinite(age) || age < -60_000 || age > 30 * 60_000) return;
  await withTransaction(database, client => queueStartedWhatsApp(client,env,{tenantId:event.tenant_id,
    deliveryId:event.aggregate_id,source:'AUTOMATIC',actorId:null}));
}

export async function processStartedWhatsApp(database: Database, env: AppEnv, tenantId: string, messageId: string): Promise<boolean> {
  const claimed = await withTransaction(database, async client => {
    // Lock delivery first, as enqueue does, to avoid lock-order inversion.
    const lookup = (await client.query<{ delivery_id: string }>(`SELECT delivery_id FROM rastreia.message_deliveries
      WHERE id=$1 AND tenant_id=$2 AND purpose=$3`,[messageId,tenantId,purpose])).rows[0];
    if (!lookup) return { handled: false as const };
    const d = await delivery(client,tenantId,lookup.delivery_id,true);
    const m = (await client.query<Notice>('SELECT * FROM rastreia.message_deliveries WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[messageId,tenantId])).rows[0]!;
    if (m.status === 'PROCESSING') {
      // Worker may have died after Meta accepted: never blindly resend.
      await client.query(`UPDATE rastreia.message_deliveries SET status='UNKNOWN',last_error_code='SUBMISSION_UNKNOWN' WHERE id=$1`,[m.id]);
      return {handled:true as const};
    }
    if (!['PENDING','RETRYING'].includes(m.status)) return {handled:true as const};
    const p = decryptPayload<Payload>(m.encrypted_payload,secret(env));
    const validToken = (await client.query(`SELECT 1 FROM rastreia.tracking_tokens WHERE id=$1 AND tenant_id=$2
      AND delivery_id=$3 AND revoked_at IS NULL AND expires_at>now()`,[m.tracking_token_id,tenantId,m.delivery_id])).rowCount;
    const reason = !d ? 'DELIVERY_UNAVAILABLE' : eligibility(d,env,m.trigger_source)
      || (recipient(d) !== p.to || d.company_id !== p.companyId ? 'RECIPIENT_CHANGED' : null)
      || (!validToken ? 'TRACKING_REVOKED_OR_EXPIRED' : null)
      || (m.provider_phone_number_id !== (env.WHATSAPP_PHONE_NUMBER_ID || null)
        || p.template !== env.WHATSAPP_DELIVERY_STARTED_TEMPLATE || p.language !== env.WHATSAPP_TEMPLATE_LANGUAGE ? 'SENDER_CONFIGURATION_CHANGED' : null);
    if (reason) {
      await client.query(`UPDATE rastreia.message_deliveries SET status='SKIPPED',last_error_code=$2 WHERE id=$1`,[m.id,reason]);
      return {handled:true as const};
    }
    await client.query(`UPDATE rastreia.message_deliveries SET status='PROCESSING',attempt_count=attempt_count+1 WHERE id=$1`,[m.id]);
    return {handled:true as const,message:m,payload:p};
  });
  if (!claimed.handled || !claimed.message || !claimed.payload) return claimed.handled;
  const { message: m, payload: p } = claimed;
  let providerId: string | null = null, httpStatus: number | null = null, state = 'UNKNOWN', code: string | null = 'SUBMISSION_UNKNOWN';
  try {
    if (env.COMMUNICATIONS_MOCK) {
      state='SENT'; code=null; providerId=`mock-wa-${crypto.randomUUID()}`; httpStatus=200;
    } else {
      const response = await fetch(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,{
        method:'POST',headers:{authorization:`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,'content-type':'application/json'},
        body:JSON.stringify(trackingTemplateBody(p,m.id)),signal:AbortSignal.timeout(10_000),
      });
      httpStatus=response.status;
      const body = await response.json().catch(()=>null) as {messages?:Array<{id?:string}>;error?:{code?:number}} | null;
      if (response.ok && body?.messages?.[0]?.id) {state='SENT';code=null;providerId=body.messages[0].id;}
      else if (response.status === 429) {state='RETRYING';code='WHATSAPP_RATE_LIMIT';}
      else if (response.status >= 400 && response.status < 500) {state='FAILED';code=`WHATSAPP_REJECTED_${body?.error?.code ?? response.status}`;}
      // Timeout, invalid success or 5xx is ambiguous: wait for webhook/manual review, not another POST.
    }
  } catch { /* Keep UNKNOWN; never log destination, credentials or tracking URL. */ }
  await withTransaction(database, async client => {
    await client.query(`UPDATE rastreia.message_deliveries SET status=$2::rastreia.message_delivery_status,
      provider_message_id=COALESCE($3,provider_message_id),sent_at=CASE WHEN $2='SENT' THEN COALESCE(sent_at,now()) ELSE sent_at END,
      failed_at=CASE WHEN $2='FAILED' THEN now() ELSE failed_at END,last_error_code=$4::text,
      last_error_message=CASE WHEN $4::text IS NULL THEN NULL ELSE 'Consulte o estado do aviso antes de tentar novamente.' END
      WHERE id=$1 AND status IN ('PROCESSING','UNKNOWN')`,[m.id,state,providerId,code]);
    await client.query(`INSERT INTO rastreia.notification_attempts(tenant_id,channel,message_delivery_id,attempt_number,
      success,provider_status,provider_message_id,error_code) VALUES($1,'WHATSAPP',$2,$3,$4,$5,$6,$7)`,
    [tenantId,m.id,m.attempt_count+1,state==='SENT',httpStatus,providerId,code]);
  });
  if (state === 'RETRYING') throw new Error('WHATSAPP_RATE_LIMIT');
  return true;
}
