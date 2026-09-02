import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import type { PlatformAuthContext } from '../auth/auth.types.js';
import { conflict, notFound } from '../../shared/errors.js';
import { encryptPayload } from '../../shared/encrypted-payload.js';
import { cents, type BillingProfileInput, type InvoiceInput } from './billing.schemas.js';
import type { InvoiceRow, InvoiceDetailRow, BillingProfileRow } from './billing.types.js';

export async function masterAudit(client:PoolClient,auth:PlatformAuthContext,input:{action:string;entityType:string;entityId:string;
  tenantId?:string;before?:unknown;after?:unknown;reason:string}) {
  await client.query(`INSERT INTO platform_audit_logs(actor_platform_admin_id,action,entity_type,entity_id,target_tenant_id,before_data,after_data,reason)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,[auth.userId,input.action,input.entityType,input.entityId,input.tenantId??null,
      JSON.stringify(input.before??null),JSON.stringify(input.after??null),input.reason]);
}
export async function saveBillingProfile(client:PoolClient,env:AppEnv,auth:PlatformAuthContext,storeId:string,
  input:BillingProfileInput,reason:string,expectedVersion?:number) {
  const store=(await client.query('SELECT id,tenant_id FROM stores WHERE id=$1 FOR UPDATE',[storeId])).rows[0];
  if(!store) throw notFound('Unidade não encontrada.');
  const before=(await client.query<BillingProfileRow>('SELECT * FROM billing_profiles WHERE store_id=$1 FOR UPDATE',[storeId])).rows[0];
  if(before && expectedVersion!==before.version) throw conflict('Dados alterados em outra sessão; recarregue antes de salvar.');
  const result=await client.query(`INSERT INTO billing_profiles(tenant_id,store_id,legal_name,trade_name,tax_id_encrypted,state_registration,
    municipal_registration,financial_email,financial_phone,financial_contact,billing_address,plan_code,recurring_amount,additional_amount,
    due_day,starts_on,preferred_payment_method,grace_days,timezone,internal_notes,enabled)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    ON CONFLICT(store_id) DO UPDATE SET legal_name=EXCLUDED.legal_name,trade_name=EXCLUDED.trade_name,tax_id_encrypted=EXCLUDED.tax_id_encrypted,
      state_registration=EXCLUDED.state_registration,municipal_registration=EXCLUDED.municipal_registration,financial_email=EXCLUDED.financial_email,
      financial_phone=EXCLUDED.financial_phone,financial_contact=EXCLUDED.financial_contact,billing_address=EXCLUDED.billing_address,
      plan_code=EXCLUDED.plan_code,recurring_amount=EXCLUDED.recurring_amount,additional_amount=EXCLUDED.additional_amount,due_day=EXCLUDED.due_day,
      starts_on=EXCLUDED.starts_on,preferred_payment_method=EXCLUDED.preferred_payment_method,grace_days=EXCLUDED.grace_days,
      timezone=EXCLUDED.timezone,internal_notes=EXCLUDED.internal_notes,enabled=EXCLUDED.enabled,version=billing_profiles.version+1,updated_at=now()
    RETURNING id,version`,[store.tenant_id,storeId,input.legalName,input.tradeName,
      encryptPayload({taxId:input.taxId},env.MESSAGE_PAYLOAD_SECRET||env.TRACKING_TOKEN_PEPPER),input.stateRegistration,input.municipalRegistration,
      input.financialEmail,input.financialPhone,input.financialContact,JSON.stringify(input.billingAddress),input.planCode,input.recurringAmount,
      input.additionalAmount,input.dueDay,input.startsOn,input.preferredPaymentMethod,input.graceDays,input.timezone,input.internalNotes,input.enabled]);
  const sanitize=(value:Record<string,unknown>|undefined)=>{if(!value)return null;
    return Object.fromEntries(Object.entries(value).filter(([key])=>!['taxId','tax_id_encrypted'].includes(key)));};
  await masterAudit(client,auth,{action:'billing.profile_updated',entityType:'billing_profile',entityId:result.rows[0].id,
    tenantId:store.tenant_id,before:sanitize(before),after:{...sanitize(input),taxIdMasked:`***${input.taxId.slice(-4)}`},reason});
  return result.rows[0];
}
export const invoiceSelect=`SELECT invoice.*,store.name AS store_name,tenant.name AS tenant_name,
  COALESCE((SELECT sum(amount) FROM invoice_items WHERE invoice_id=invoice.id),0)::text AS total,
  COALESCE((SELECT sum(amount) FROM invoice_payments WHERE invoice_id=invoice.id),0)::text AS paid,
  (COALESCE((SELECT sum(amount) FROM invoice_items WHERE invoice_id=invoice.id),0)-
   COALESCE((SELECT sum(amount) FROM invoice_payments WHERE invoice_id=invoice.id),0))::text AS balance,
  GREATEST(0,(now() AT TIME ZONE invoice.timezone)::date-invoice.due_date) AS days_overdue
 FROM invoices invoice JOIN stores store ON store.id=invoice.store_id JOIN tenants tenant ON tenant.id=invoice.tenant_id`;
export async function invoiceDetail(client:PoolClient,id:string) {
  const invoice=(await client.query<InvoiceDetailRow>(`${invoiceSelect} WHERE invoice.id=$1`,[id])).rows[0];
  if(!invoice) throw notFound('Fatura não encontrada.');
  const items=await client.query('SELECT id,description,amount::text FROM invoice_items WHERE invoice_id=$1 ORDER BY created_at,id',[id]);
  // Internal notes and administrative reasons never enter the tenant DTO.
  const payments=await client.query('SELECT id,amount::text,paid_at,method,reference FROM invoice_payments WHERE invoice_id=$1 ORDER BY paid_at',[id]);
  const history=await client.query('SELECT from_status,to_status,created_at FROM invoice_status_history WHERE invoice_id=$1 ORDER BY created_at,id',[id]);
  return {...invoice,items:items.rows,payments:payments.rows,history:history.rows};
}
export async function recordInvoiceState(client:PoolClient,invoice:{id:string;tenant_id:string;status:string},status:string,
  reason:string,actor?:string) {
  if(invoice.status===status)return;
  await client.query(`UPDATE invoices SET status=$2,version=version+1,updated_at=now(),
    issued_at=CASE WHEN $2='ISSUED' THEN COALESCE(issued_at,now()) ELSE issued_at END,
    paid_at=CASE WHEN $2='PAID' THEN now() ELSE paid_at END WHERE id=$1`,[invoice.id,status]);
  await client.query(`INSERT INTO invoice_status_history(tenant_id,invoice_id,from_status,to_status,reason,actor_platform_admin_id)
    VALUES($1,$2,$3,$4,$5,$6)`,[invoice.tenant_id,invoice.id,invoice.status,status,reason,actor??null]);
}
export async function createInvoice(client:PoolClient,auth:PlatformAuthContext,input:InvoiceInput) {
  const profile=(await client.query(`SELECT profile.tenant_id,profile.timezone FROM billing_profiles profile
    JOIN stores store ON store.id=profile.store_id WHERE profile.store_id=$1 FOR UPDATE OF store`,[input.storeId])).rows[0];
  if(!profile)throw conflict('Cadastre os dados de faturamento da unidade antes de criar a fatura.');
  const invoice=(await client.query<InvoiceRow>(`INSERT INTO invoices(tenant_id,store_id,period,charge_type,description,due_date,timezone)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[profile.tenant_id,input.storeId,input.period,input.chargeType,input.description,input.dueDate,profile.timezone])).rows[0]!;
  for(const item of input.items)await client.query('INSERT INTO invoice_items(tenant_id,invoice_id,description,amount) VALUES($1,$2,$3,$4)',
    [invoice.tenant_id,invoice.id,item.description,item.amount]);
  await client.query(`INSERT INTO invoice_status_history(tenant_id,invoice_id,to_status,reason,actor_platform_admin_id)
    VALUES($1,$2,'DRAFT',$3,$4)`,[invoice.tenant_id,invoice.id,input.reason,auth.userId]);
  await masterAudit(client,auth,{action:'invoice.created',entityType:'invoice',entityId:invoice.id,tenantId:invoice.tenant_id,after:input,reason:input.reason});
  return invoiceDetail(client,invoice.id);
}
export async function lockInvoice(client:PoolClient,id:string) {
  const found=(await client.query('SELECT store_id FROM invoices WHERE id=$1',[id])).rows[0];if(!found)throw notFound();
  await client.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE',[found.store_id]);
  const invoice=(await client.query<InvoiceRow>('SELECT * FROM invoices WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!invoice)throw notFound();return invoice;
}
export async function reconcileFinancialHold(client:PoolClient,storeId:string,actor?:string) {
  const pending=(await client.query(`SELECT min(suspension_scheduled_at) AS scheduled_at FROM invoices
    WHERE store_id=$1 AND status='DELINQUENT'`,[storeId])).rows[0]?.scheduled_at;
  if(pending)return;
  const released=await client.query(`UPDATE unit_financial_holds SET released_at=now(),scheduled_at=NULL,updated_at=now()
    WHERE store_id=$1 AND released_at IS NULL RETURNING id,tenant_id`,[storeId]);
  if(released.rowCount)await client.query(`INSERT INTO platform_audit_logs(actor_platform_admin_id,action,entity_type,entity_id,target_tenant_id,reason)
    VALUES($1,'billing.hold_released','store',$2,$3,'Não há fatura inadimplente em aberto.')`,[actor??null,storeId,released.rows[0].tenant_id]);
}
export async function registerInvoicePayment(client:PoolClient,auth:PlatformAuthContext,id:string,key:string,input:{
  amount:string;paidAt:string;method:string;reference?:string|undefined;reason:string}) {
  const invoice=await lockInvoice(client,id);
  if(!['ISSUED','OVERDUE','DELINQUENT'].includes(invoice.status))throw conflict('Esta fatura não aceita pagamento.');
  const detail=await invoiceDetail(client,id);
  if(cents(input.amount)<=0n||cents(input.amount)>cents(detail.balance))throw conflict('O valor deve ser positivo e não pode ultrapassar o saldo.');
  await client.query(`INSERT INTO invoice_payments(tenant_id,invoice_id,amount,paid_at,method,reference,idempotency_key,actor_platform_admin_id,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[invoice.tenant_id,id,input.amount,input.paidAt,input.method,input.reference??null,`${auth.userId}:${key}`,auth.userId,input.reason]);
  if(cents(input.amount)===cents(detail.balance))await recordInvoiceState(client,invoice,'PAID',input.reason,auth.userId);
  await reconcileFinancialHold(client,invoice.store_id,auth.userId);
  await masterAudit(client,auth,{action:'invoice.payment_registered',entityType:'invoice',entityId:id,tenantId:invoice.tenant_id,
    before:{balance:detail.balance},after:{amount:input.amount,method:input.method},reason:input.reason});
  return invoiceDetail(client,id);
}
