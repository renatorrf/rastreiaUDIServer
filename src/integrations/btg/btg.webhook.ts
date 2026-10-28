import { createHash,timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withTransaction,type Database } from '../../database/pool.js';
import { decryptPayload } from '../../shared/encrypted-payload.js';

export const BTG_PIX_WEBHOOK='/integrations/btg/pix/webhook';
const identifier=z.string().min(1).max(200);
const envelope=z.object({webhookId:z.uuid().transform(v=>v.toLowerCase()),event:z.string().min(1).max(120),data:z.unknown()});
const paid=z.object({id:identifier,txId:identifier,status:z.literal('PAID'),pixKey:z.string().min(1).max(140),
 location:z.object({id:identifier}),payee:z.object({taxId:z.string().regex(/^\d{14}$/)}),displayText:z.string().max(500).optional()});
type PaidEvent=z.infer<typeof paid>;
interface Configuration {companyId:string;secret:string;}
export interface BtgWebhookStore {
 configuration(this:void,webhookId:string):Promise<Configuration|null>;
 enqueue(this:void,companyId:string,webhookId:string,event:PaidEvent):Promise<void>;
}
const digest=(value:string)=>createHash('sha256').update(value).digest();
function authenticated(header:string|undefined,secret:string){
 const match=header?.match(/^Bearer ([\x21-\x7e]{32,2048})$/i);
 return !!match&&secret.length>=32&&timingSafeEqual(digest(match[1]!),digest(secret));
}
export function createBtgWebhookStore(db:Database,env:AppEnv):BtgWebhookStore {
 return {
  async configuration(webhookId){
   const row=(await db.query<{company_id:string;secret_config_encrypted:string|null}>(`SELECT s.company_id,s.secret_config_encrypted
    FROM rastreia.company_service_settings s JOIN rastreia.companies c ON c.id=s.company_id AND c.tenant_id=s.tenant_id
    WHERE s.provider='BTG' AND s.enabled AND c.status='ACTIVE' AND s.public_config->>'mode'='production'
    AND lower(s.public_config->>'webhookId')=$1 LIMIT 1`,[webhookId])).rows[0];
   if(!row?.secret_config_encrypted)return null;
   const secrets=decryptPayload<Record<string,string>>(row.secret_config_encrypted,env.BTG_ENCRYPTION_SECRET);
   return {companyId:row.company_id,secret:secrets['webhookSecret']??''};
  },
  async enqueue(companyId,webhookId,event){
   await withTransaction(db,async c=>{
    await c.query("SET LOCAL statement_timeout='4000ms'");
    await c.query("SET LOCAL lock_timeout='2000ms'");
    // Never trust order/company IDs from tags. Resolve only this authenticated company's saved charge.
    const orderId=event.displayText?.match(/^Rastreia ([0-9a-f-]{36})$/i)?.[1];
    const match=(await c.query<{order_id:string}>(`SELECT p.order_id FROM rastreia.commerce_pix_payments p
     WHERE p.company_id=$1 AND p.tax_id=$2 AND p.pix_key=$3 AND p.paid_at IS NULL
     AND p.created_at>now()-interval '7 days'
     AND ((p.provider_id=$4) OR (p.provider_id IS NULL AND p.order_id::text=$7))
     AND (p.tx_id IS NULL OR p.tx_id=$5) AND (p.location_id IS NULL OR p.location_id=$6)
     LIMIT 1 FOR UPDATE`,[companyId,event.payee.taxId,event.pixKey,event.id,event.txId,event.location.id,orderId??null])).rows[0];
    if(!match)return; // Identical response for unknown, already paid and unrelated charges.
    const key=createHash('sha256').update(JSON.stringify([webhookId,'instant-collection.paid',event.id,event.txId])).digest('hex');
    const receipt=await c.query(`INSERT INTO rastreia.btg_pix_webhook_receipts(company_id,event_key,order_id) VALUES($1,$2,$3)
     ON CONFLICT(company_id,event_key) DO NOTHING RETURNING order_id`,[companyId,key,match.order_id]);
    if(receipt.rowCount)await c.query('UPDATE rastreia.commerce_pix_payments SET next_check_at=LEAST(next_check_at,now()) WHERE order_id=$1',[match.order_id]);
    // No payment state, inventory, fulfillment or finance is changed from a webhook payload.
   });
  },
 };
}
export async function btgWebhookRoutes(app:FastifyInstance,db:Database,env:AppEnv,store=createBtgWebhookStore(db,env)){
 app.post(BTG_PIX_WEBHOOK,{bodyLimit:32768,config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async(req,reply)=>{
  reply.header('Cache-Control','no-store');
  if(!env.BTG_ENABLED||!env.BTG_ENCRYPTION_SECRET)return reply.code(503).send({error:'BTG_WEBHOOK_UNAVAILABLE'});
  if(!/^Bearer [\x21-\x7e]{32,2048}$/i.test(req.headers.authorization??''))return reply.code(401).send({error:'BTG_WEBHOOK_UNAUTHORIZED'});
  const parsed=envelope.safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'BTG_WEBHOOK_INVALID'});
  try{
   const config=await store.configuration(parsed.data.webhookId);
   if(!config||!authenticated(req.headers.authorization,config.secret))return reply.code(401).send({error:'BTG_WEBHOOK_UNAUTHORIZED'});
   if(parsed.data.event!=='instant-collection.paid')return reply.code(200).send({received:true});
   const event=paid.safeParse(parsed.data.data);
   if(!event.success)return reply.code(400).send({error:'BTG_WEBHOOK_INVALID'});
   await store.enqueue(config.companyId,parsed.data.webhookId,event.data);
   return reply.code(200).send({received:true});
  }catch{
   req.log.warn({reason:'BTG_WEBHOOK_RETRY'},'BTG webhook could not be queued');
   return reply.code(503).send({error:'BTG_WEBHOOK_RETRY'});
  }
 });
}
