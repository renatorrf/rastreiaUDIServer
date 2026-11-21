import {z} from 'zod';
import type {PoolClient} from 'pg';
import {withTransaction,type Database} from '../../database/pool.js';
import type {AppEnv} from '../../config/env.js';
import {whatsappRecipient} from './tracking-whatsapp.service.js';

const change=z.object({field:z.literal('messages'),value:z.object({metadata:z.object({phone_number_id:z.string()}),messages:z.array(z.unknown())})});
const button=z.object({type:z.literal('button'),from:z.string(),button:z.object({payload:z.string().optional(),text:z.string().optional()})});
export function stoppedRecipients(payload:unknown,phoneId:string){
  const result=new Set<string>();
  const body=z.object({object:z.literal('whatsapp_business_account'),entry:z.array(z.object({changes:z.array(z.unknown())}))}).safeParse(payload);
  if(!phoneId||!body.success)return result;
  for(const entry of body.data.entry)for(const raw of entry.changes){
    const event=change.safeParse(raw);if(!event.success||event.data.value.metadata.phone_number_id!==phoneId)continue;
    for(const value of event.data.value.messages){
      const b=button.safeParse(value);if(!b.success)continue;
      if(b.data.button.payload!=='RETENTION_STOP'&&b.data.button.text?.trim().toLowerCase()!=='parar ofertas')continue;
      const phone=whatsappRecipient(b.data.from);if(phone)result.add(phone);
      // Some Brazilian WhatsApp IDs still omit the mobile ninth digit. These aliases
      // are used exclusively for suppression, never to infer a send destination.
      if(/^55\d{2}[6-9]\d{7}$/.test(b.data.from)){
        const mobile=whatsappRecipient(b.data.from.slice(0,4)+'9'+b.data.from.slice(4));if(mobile)result.add(mobile);
      }
    }
  }
  return result;
}
interface Notice{id:string;percent:number;product_name:string;first_name:string;store_name:string;expires_at:Date;whatsapp:string}
export function offerTemplate(row:Notice,env:AppEnv){
  const date=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(row.expires_at);
  const benefit=(row.percent===100?'uma unidade grátis de ':row.percent+'% de desconto em uma unidade de ')+row.product_name;
  return {messaging_product:'whatsapp',to:row.whatsapp,type:'template',template:{name:env.WHATSAPP_OFFERS_TEMPLATE,language:{code:env.WHATSAPP_OFFERS_LANGUAGE},components:[
    {type:'body',parameters:[row.first_name,row.store_name,benefit,date].map(s=>({type:'text',text:s.replace(/\s+/g,' ').trim()}))},
    {type:'button',sub_type:'url',index:'0',parameters:[{type:'text',text:row.id}]},
    {type:'button',sub_type:'quick_reply',index:'1',parameters:[{type:'payload',payload:'RETENTION_STOP'}]}
  ]}};
}
export async function claimRetentionNotice(c:PoolClient){
    const offer=(await c.query<Notice&{eligible:boolean}>(`SELECT o.*,coalesce(pc.whatsapp,p.whatsapp) AS whatsapp,coalesce(o.expires_at>now() AND o.order_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM rastreia.retention_whatsapp_stops WHERE phone_key=coalesce(pc.whatsapp,p.whatsapp))
      AND CASE WHEN o.phone_consent_id IS NULL THEN p.enabled AND p.updated_at<=o.created_at AND EXISTS(SELECT 1 FROM rastreia.customer_profiles cp JOIN rastreia.stores s ON s.tenant_id=cp.tenant_id
        WHERE s.id=o.store_id AND cp.user_id=o.user_id AND cp.status='ACTIVE'
        AND p.whatsapp IN (cp.whatsapp_normalized,'55'||cp.whatsapp_normalized))
      ELSE pc.enabled AND pc.store_id=o.store_id AND o.user_id IS NULL AND NOT EXISTS(
        SELECT 1 FROM rastreia.retention_phone_consents newer WHERE newer.store_id=pc.store_id AND newer.whatsapp=pc.whatsapp AND newer.id>pc.id)
        AND EXISTS(SELECT 1 FROM rastreia.deliveries d WHERE d.id=o.source_delivery_id AND d.store_id=o.store_id AND d.status='DELIVERED'
          AND rastreia.retention_delivery_phone(d.origin,d.recipient_whatsapp,d.recipient_phone)=pc.whatsapp)
        AND NOT EXISTS(SELECT 1 FROM rastreia.retention_preferences pref WHERE pref.store_id=o.store_id AND pref.whatsapp=pc.whatsapp AND NOT pref.enabled)
      END
      AND rastreia.commerce_public_store(o.slug) IS NOT NULL,false) eligible
      FROM rastreia.retention_offers o LEFT JOIN rastreia.retention_preferences p ON p.store_id=o.store_id AND p.user_id=o.user_id
      LEFT JOIN rastreia.retention_phone_consents pc ON pc.id=o.phone_consent_id
      WHERE o.dispatch='QUEUED' ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`)).rows[0];
    if(!offer)return;
    await c.query('UPDATE rastreia.retention_offers SET dispatch=$2 WHERE id=$1',[offer.id,offer.eligible?'PROCESSING':'SKIPPED']);return offer.eligible?offer:undefined;
}
export async function processRetentionOffer(db:Database,env:AppEnv){
  if(!env.WHATSAPP_OFFERS_ENABLED||env.COMMUNICATIONS_MOCK||!env.WHATSAPP_ACCESS_TOKEN||!env.WHATSAPP_PHONE_NUMBER_ID||!env.WHATSAPP_APP_SECRET||
    [env.WHATSAPP_TRACKING_TEMPLATE,env.WHATSAPP_DELIVERY_STARTED_TEMPLATE].includes(env.WHATSAPP_OFFERS_TEMPLATE))return;
  const row=await withTransaction(db,claimRetentionNotice);
  if(!row)return;
  let status='UNKNOWN';
  try{const res=await fetch(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,{
    method:'POST',headers:{Authorization:'Bearer '+env.WHATSAPP_ACCESS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(offerTemplate(row,env)),signal:AbortSignal.timeout(12000)});
    status=res.ok?'ACCEPTED':res.status>=500?'UNKNOWN':'FAILED';
  }catch{/* A timeout can follow acceptance. Never resend automatically. */}
  await db.query("UPDATE rastreia.retention_offers SET dispatch=$2 WHERE id=$1 AND dispatch='PROCESSING'",[row.id,status]);
}
