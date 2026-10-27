import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import { withTransaction,type Database } from '../../database/pool.js';
import { resolveCompanyService,companyServiceConfigured } from '../company-settings/company-settings.service.js';
import { decryptPayload,encryptPayload } from '../../shared/encrypted-payload.js';
import { AppError } from '../../shared/errors.js';
import { BTG_SCOPE,tokenSchema,type BtgTokens } from '../../integrations/btg/btg.oauth.js';
import { BtgPixClient,assertCharge,bankCents } from '../../integrations/btg/btg.pix.js';

type SavedTokens=BtgTokens&{companyId:string;tenantId:string;mode:string;clientId:string};
const unavailable=()=>new AppError(409,'PIX_CONFIGURATION_REQUIRED','Configure a chave Pix, o CNPJ da empresa e autorize o BTG em produção antes de habilitar o pagamento.');
/** Trusted server only. Company is always resolved from a previously authorized store/order. */
export async function pixConnection(db:Database,env:AppEnv,companyId:string,fetcher:typeof fetch=fetch){
 if(!env.BTG_ENABLED||!env.BTG_ENCRYPTION_SECRET)throw unavailable();
 return withTransaction(db,async c=>{
  const company=(await c.query<{tenant_id:string;tax_id_encrypted:string;status:string}>('SELECT tenant_id,tax_id_encrypted,status FROM rastreia.companies WHERE id=$1',[companyId])).rows[0];
  await c.query("SELECT id FROM rastreia.company_service_settings WHERE company_id=$1 AND provider='BTG' FOR SHARE",[companyId]);
  const config=await resolveCompanyService(c,env,companyId,'BTG');
  // Sandbox contains static charges, never use mocked payments to release real stock/orders.
  if(!company||company.status!=='ACTIVE'||!company.tax_id_encrypted||!companyServiceConfigured(config)||config.values['mode']!=='production'||!config.values['pixKey'])throw unavailable();
  const taxId=decryptPayload<{taxId:string}>(company.tax_id_encrypted,env.MESSAGE_PAYLOAD_SECRET||env.TRACKING_TOKEN_PEPPER).taxId.replace(/\D/g,'');
  if(!/^\d{14}$/.test(taxId))throw unavailable();
  const row=(await c.query<{tokens_encrypted:string;expires_at:Date;settings_version:number}>("SELECT tokens_encrypted,expires_at,settings_version FROM rastreia.btg_authorizations WHERE company_id=$1 AND mode='production' FOR UPDATE",[companyId])).rows[0];
  if(!row||row.settings_version!==config.version)throw unavailable();
  let tokens=decryptPayload<SavedTokens>(row.tokens_encrypted,env.BTG_ENCRYPTION_SECRET);
  if(tokens.companyId!==companyId||tokens.tenantId!==company.tenant_id||tokens.mode!=='production'||tokens.clientId!==config.values['clientId'])throw unavailable();
  if(new Date(row.expires_at).getTime()<Date.now()+60000){
   try{
    const response=await fetcher('https://id.btgpactual.com/oauth2/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded',
     Authorization:`Basic ${Buffer.from(`${String(config.values['clientId'])}:${String(config.values['clientSecret'])}`).toString('base64')}`},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:tokens.refresh_token})});
    if(!response.ok)throw unavailable();
    const refreshed=tokenSchema.parse(await response.json());if(!BTG_SCOPE.split(' ').every(s=>refreshed.scope.split(' ').includes(s)))throw unavailable();
    tokens={...tokens,...refreshed};
    await c.query("UPDATE rastreia.btg_authorizations SET tokens_encrypted=$2,expires_at=$3,updated_at=now() WHERE company_id=$1 AND mode='production'",
     [companyId,encryptPayload(tokens,env.BTG_ENCRYPTION_SECRET),new Date(Date.now()+refreshed.expires_in*1000)]);
   }catch{throw unavailable();}
  }
  return {api:new BtgPixClient(tokens.access_token,taxId,fetcher),taxId,pixKey:String(config.values['pixKey']),version:config.version};
 });
}
interface PaymentRow {order_id:string;company_id:string;status:string;expires_at:Date;created_at:Date;settings_version:number|null;tax_id:string|null;pix_key:string|null;
 provider_id:string|null;tx_id:string|null;location_id:string|null;paid_at:Date|null;amount:string;order_status:string;}
export async function processPixOrder(db:Database,env:AppEnv,id:string,fetcher:typeof fetch=fetch){
 if(!env.BTG_ENABLED)return;
 const c=await db.connect();let locked=false;
 try{
  // Session lock spans the external call; REQUESTED is committed before any POST.
  locked=(await c.query<{locked:boolean}>("SELECT pg_try_advisory_lock(hashtext('commerce-pix:'||$1)) AS locked",[id])).rows[0]!.locked;if(!locked)return;
  const p=(await c.query<PaymentRow>(`SELECT p.*,o.subtotal_cents+o.delivery_fee_cents AS amount,o.status AS order_status FROM rastreia.commerce_pix_payments p JOIN rastreia.commerce_orders o ON o.id=p.order_id
   WHERE p.order_id=$1 AND p.paid_at IS NULL AND p.next_check_at<=now()`,[id])).rows[0];if(!p)return;
  await c.query("UPDATE rastreia.commerce_pix_payments SET next_check_at=now()+CASE WHEN expires_at<=now() THEN interval '10 minutes' ELSE interval '30 seconds' END WHERE order_id=$1",[id]);
  const connection=await pixConnection(db,env,p.company_id,fetcher);
  if(p.status==='CREATED'){
   if(new Date(p.expires_at).getTime()<=Date.now()+30000||p.order_status!=='WAITING_PAYMENT')return;
   await connection.api.validateAccount();
   await c.query("UPDATE rastreia.commerce_pix_payments SET status='REQUESTED',settings_version=$2,tax_id=$3,pix_key=$4 WHERE order_id=$1",[id,connection.version,connection.taxId,connection.pixKey]);
   try{
    const charge=await connection.api.create({orderId:id,pixKey:connection.pixKey,amountCents:Number(p.amount),expiresIn:Math.max(1,Math.floor((new Date(p.expires_at).getTime()-Date.now())/1000))});
    await c.query(`UPDATE rastreia.commerce_pix_payments SET status=CASE WHEN expires_at>now() THEN 'PENDING' ELSE 'EXPIRED' END,
     provider_id=$2,tx_id=$3,location_id=$4,emv=$5 WHERE order_id=$1`,[id,charge.id,charge.txId,charge.location.id,charge.emv]);
   }catch{
    // A timeout may have created the charge. Never POST again for this order.
    await c.query("UPDATE rastreia.commerce_pix_payments SET status='REVIEW_REQUIRED',review_reason='CREATE_OUTCOME_UNKNOWN' WHERE order_id=$1",[id]);
   }
   return;
  }
  if(!p.tax_id||!p.pix_key)return;
  // Credential changes cannot redirect or settle an existing payment for another account.
  if(connection.taxId!==p.tax_id)throw unavailable();
  const charges=await connection.api.find(new Date(p.created_at),p.location_id);
  const matches=charges.filter(v=>p.provider_id?v.id===p.provider_id:v.displayText===`Rastreia ${id}`);
  if(matches.length!==1)return;
  const charge=matches[0]!;assertCharge(charge,{taxId:p.tax_id,pixKey:p.pix_key,amountCents:Number(p.amount),providerId:p.provider_id,txId:p.tx_id,locationId:p.location_id});
  // Unknown POST outcome can be reconciled, but its code is never regenerated or replaced.
  await c.query('UPDATE rastreia.commerce_pix_payments SET provider_id=$2,tx_id=$3,location_id=$4 WHERE order_id=$1',[id,charge.id,charge.txId,charge.location.id]);
  if(charge.status==='PAID'&&charge.paymentInfo){
   const info=charge.paymentInfo;
   await withTransaction(db,tx=>tx.query('SELECT rastreia.commerce_pix_settle($1,$2,$3,$4)',[id,bankCents(info.paidAmount),info.endToEndId,info.paymentDate]));
  }
 }finally{try{if(locked)await c.query("SELECT pg_advisory_unlock(hashtext('commerce-pix:'||$1))",[id]);}finally{c.release();}}
}
export async function maintainCommercePix(db:Database,env:AppEnv){
 if(!env.BTG_ENABLED)return;
 const rows=await db.query<{order_id:string}>(`SELECT order_id FROM rastreia.commerce_pix_payments WHERE paid_at IS NULL AND next_check_at<=now()
 AND created_at>now()-interval '7 days' AND (tax_id IS NOT NULL OR status='CREATED') ORDER BY (expires_at>now()) DESC,next_check_at LIMIT 3`);
 let failed=0;
 await Promise.all(rows.rows.map(async row=>{try{await processPixOrder(db,env,row.order_id);}catch{failed++;}}));
 if(failed)throw new Error('PIX_RECONCILIATION_RETRY_REQUIRED'); // Safe worker diagnostic, never bank bodies/tokens.
}
export async function storePaymentSettings(c:PoolClient,storeId:string){
 return (await c.query('SELECT enabled,delivery_fee_cents AS "deliveryFeeCents",version FROM commerce_payment_settings WHERE store_id=$1',[storeId])).rows[0]??{enabled:false,deliveryFeeCents:0,version:0};
}
