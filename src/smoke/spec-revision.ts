import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool } from '../database/pool.js';
import { decryptPayload } from '../shared/encrypted-payload.js';
import { processBillingBatch } from '../modules/billing/billing-worker.service.js';
import { rollbackDatabase } from './rollback-database.js';

loadLocalEnv();
const source=getEnv();
if(source.NODE_ENV==='production')throw new Error('Run this rollback smoke only against development/test.');
const prefix=`revision-${randomBytes(6).toString('hex')}`;
const env={...source,NODE_ENV:'test' as const,LOG_LEVEL:'error' as const,
  REDIS_URL:'',REDIS_REQUIRED:false,COMMUNICATIONS_MOCK:true,BILLING_ENABLED:false,
  SMTP_HOST:'smtp.example.invalid',SMTP_FROM:'noreply@example.test',PUBLIC_COURIER_REGISTRATION_ENABLED:true,
  EMAIL_ACTION_BASE_URL:'https://app.example.test',TERMS_URL:'https://app.example.test/terms',PRIVACY_URL:'https://app.example.test/privacy'};
const pool=createPool(env);
const connection=await pool.connect();
await connection.query('BEGIN');
await connection.query("SET LOCAL lock_timeout='5s'");
const database=rollbackDatabase(pool,connection);
let app:Awaited<ReturnType<typeof buildApp>>|undefined;
let checks=0;
function check(value:unknown,message:string){assert.ok(value,message);checks++;}
try {
  const migrated=await database.query("SELECT 1 FROM pg_trigger WHERE tgname='stores_master_only'");
  if(!migrated.rowCount)await database.query(await readFile(resolve('migrations/0032_explicit_unit_scope.sql'),'utf8'));
  const masterId=randomUUID();const password='Synthetic-only-password-3489!';
  await database.query(`INSERT INTO rastreia.platform_admins(id,name,email,password_hash) VALUES($1,'Master de teste',$2,$3)`,[masterId,`${prefix}-master@example.test`,await argon2.hash(password)]);
  app=await buildApp({env,database});
  const call=async(method:'GET'|'POST'|'PATCH'|'PUT',url:string,payload?:Record<string,unknown>,token?:string,key=randomUUID())=>{
    const response=await app!.inject({method,url,...(payload?{payload}:{}),headers:{'idempotency-key':key,...(token?{authorization:`Bearer ${token}`}:{})}});
    return {status:response.statusCode,body:response.json(),headers:response.headers};
  };
  const master=(await call('POST','/platform/auth/login',{email:`${prefix}-master@example.test`,password})).body.accessToken as string;
  check(master,'Master authenticated');
  const billing={legalName:'Empresa teste',tradeName:'Unidade teste',taxId:'52998224725',financialEmail:'finance@example.test',financialContact:'Responsável teste',
    billingAddress:{addressLine:'Rua de teste',number:'1',neighborhood:'Centro',city:'Teste',state:'MG',postalCode:'38400000'},
    planCode:'test',recurringAmount:'100.00',dueDay:10,startsOn:'2026-01-01',enabled:false};
  const store={name:'Unidade Um',addressLine:'Rua de teste',addressNumber:'1',neighborhood:'Centro',city:'Teste',state:'MG',postalCode:'38400000',latitude:-18.9,longitude:-48.2};
  const input={tenant:{name:'Empresa teste',slug:prefix},store,manager:{name:'Gestor teste',email:`${prefix}-manager@example.test`},billing};
  const key=randomUUID();const first=await call('POST','/platform/stores',input,master,key);
  assert.equal(first.status,201,JSON.stringify(first.body));checks++;
  const unit=first.body as {id:string;tenant_id:string;manager:{id:string}};
  const replay=await call('POST','/platform/stores',input,master,key);check(replay.body.id===unit.id,'Provisioning replay');
  const conflictReplay=await call('POST','/platform/stores',{...input,store:{...store,name:'Outro nome'}},master,key);
  check(conflictReplay.status===409,'Idempotency key cannot be reused for a different provisioning payload');
  const emailToken=async(userId:string,kind:string)=>{
    const jobs=await database.query<{encrypted_payload:string}>(`SELECT job.encrypted_payload FROM rastreia.email_jobs job
      JOIN rastreia.identity_actions action ON job.dedup_key='identity:'||action.id::text
      WHERE action.user_id=$1 AND action.kind=$2 AND action.consumed_at IS NULL ORDER BY action.created_at DESC LIMIT 1`,[userId,kind]);
    const body=decryptPayload<{text:string}>(jobs.rows[0]!.encrypted_payload,env.MESSAGE_PAYLOAD_SECRET||env.TRACKING_TOKEN_PEPPER);
    return body.text.match(/#([A-Za-z0-9_-]{43})/)![1]!;
  };
  const invitation=await emailToken(unit.manager.id,'INVITE');
  check((await call('POST','/auth/accept-invite',{token:invitation,password})).status===200,'Invite acceptance');
  check((await call('POST','/auth/accept-invite',{token:invitation,password})).status===409,'Invite single use');
  const second=await call('POST','/platform/stores',{tenantId:unit.tenant_id,store:{...store,name:'Unidade Dois'},manager:input.manager,billing},master);
  assert.equal(second.status,201,JSON.stringify(second.body));checks++;
  check(second.body.manager.id===unit.manager.id,'Reuse global manager identity');
  const failedProvision=await call('POST','/platform/stores',{tenantId:unit.tenant_id,store:{...store,name:'Unidade inválida'},manager:input.manager,billing:{...billing,taxId:'11111111111'}},master);
  check(failedProvision.status===400,'Invalid fiscal profile rejects provisioning');
  const unitCount=await database.query<{count:string}>('SELECT count(*)::text FROM rastreia.stores WHERE tenant_id=$1',[unit.tenant_id]);
  check(unitCount.rows[0]?.count==='2','No partial units left by rejected provisioning');
  const identity=(await call('POST','/auth/sign-in',{email:input.manager.email,password})).body;
  check(identity.units.length===2,'Only explicitly linked units returned');
  const entered=await call('POST','/auth/enter-unit',{storeId:unit.id},identity.accessToken as string);
  assert.equal(entered.status,200,JSON.stringify(entered.body));checks++;
  const manager=entered.body.accessToken as string;
  const visible=await call('GET','/stores',undefined,manager);
  assert.equal(visible.status,200,JSON.stringify(visible.body));check(visible.body.data.length===1&&visible.body.data[0].id===unit.id,'Manager isolated to selected unit');
  check((await call('POST','/stores',store,manager)).status===403,'Manager cannot provision stores');
  check((await call('POST','/users',{name:'Outro gestor',email:`${prefix}-forbidden@example.test`,password,role:'TENANT_MANAGER',storeIds:[unit.id]},manager)).status===400,'Manager cannot create another manager');
  const parcel={storeId:unit.id,recipientName:'Destinatário sintético',recipientPhone:'34999990000',addressLine:'Rua sintética',city:'Teste',state:'MG',latitude:-18.91,longitude:-48.21};
  const delivery=await call('POST','/deliveries',parcel,manager);
  assert.equal(delivery.status,201,JSON.stringify(delivery.body));checks++;
  const deliveryId=delivery.body.id as string;
  const secondSession=await call('POST','/auth/enter-unit',{storeId:second.body.id},identity.accessToken as string);
  check((await call('GET',`/deliveries/${deliveryId}`,undefined,secondSession.body.accessToken as string)).status===404,'Other selected unit cannot read delivery by ID');
  // Fixture state simulates a trip already started; all writes are rolled back.
  await database.query("UPDATE rastreia.deliveries SET status='IN_ROUTE' WHERE id=$1",[deliveryId]);
  const tracking=await call('POST',`/deliveries/${deliveryId}/tracking-link`,{},manager);
  assert.equal(tracking.status,200,JSON.stringify(tracking.body));
  const publicToken=(tracking.body.url as string).split('/').at(-1)!;
  check((await call('GET','/platform/stores',undefined,manager)).status===401,'Tenant token cannot access Master');
  const due=new Date(Date.now()-6*86400000).toISOString().slice(0,10);
  const invoice=await call('POST','/platform/invoices',{storeId:unit.id,period:due.slice(0,7)+'-01',dueDate:due,description:'Mensalidade teste',
    items:[{description:'Plano',amount:'100.00'}],reason:'Teste automatizado isolado.'},master);
  assert.equal(invoice.status,200,JSON.stringify(invoice.body));checks++;
  const invoiceId=invoice.body.id as string;
  check((await call('GET',`/me/invoices/${invoiceId}`,undefined,secondSession.body.accessToken as string)).status===404,'Selected unit cannot open another unit invoice');
  check((await call('POST',`/platform/invoices/${invoiceId}/register-payment`,{amount:'100.00',paidAt:new Date().toISOString(),method:'TRANSFER',reason:'Tentativa não autorizada'},manager)).status===401,'Manager cannot register payments');
  check((await call('POST',`/platform/invoices/${invoiceId}/issue`,{reason:'Emissão de teste.'},master)).status===200,'Issue invoice');
  await processBillingBatch(database,unit.id);await processBillingBatch(database,unit.id);
  const notice=await database.query<{count:string}>('SELECT count(*)::text FROM rastreia.billing_notifications WHERE invoice_id=$1',[invoiceId]);
  check(notice.rows[0]?.count==='1','No duplicate delinquency notice');
  await database.query(`UPDATE rastreia.invoices SET suspension_scheduled_at=now()-interval '1 minute' WHERE id=$1`,[invoiceId]);
  await processBillingBatch(database,unit.id);await processBillingBatch(database,unit.id);
  const hold=await database.query<{allowed:boolean}>('SELECT rastreia.unit_accepts_new_operations($1) AS allowed',[unit.id]);check(hold.rows[0]?.allowed===false,'Financial hold enforced');
  check((await call('GET','/me/invoices',undefined,manager)).status===200,'Invoices remain accessible while held');
  const blockedDelivery=await call('POST','/deliveries',parcel,manager);
  check(blockedDelivery.status===409&&blockedDelivery.body.error.code==='UNIT_UNAVAILABLE','Held unit rejects new deliveries');
  check((await call('GET',`/public/tracking/${publicToken}`)).status===200,'Public tracking remains accessible while financially held');
  const noticeStatus=await call('GET','/me/billing-status',undefined,manager);
  check(noticeStatus.body.notices[0].id===invoiceId,'Persistent manager warning identifies invoice');
  check((await call('POST',`/deliveries/${deliveryId}/complete`,{},manager)).status===200,'Started delivery can finish while held');
  const payment={amount:'100.00',paidAt:new Date().toISOString(),method:'TRANSFER',reason:'Recebimento sintético conferido.'};const paymentKey=randomUUID();
  const paid=await Promise.all([call('POST',`/platform/invoices/${invoiceId}/register-payment`,payment,master,paymentKey),
    call('POST',`/platform/invoices/${invoiceId}/register-payment`,payment,master,paymentKey)]);
  assert.equal(paid[0].status,200,JSON.stringify(paid[0].body));assert.equal(paid[1].status,200,JSON.stringify(paid[1].body));checks++;
  const payments=await database.query<{count:string}>('SELECT count(*)::text FROM rastreia.invoice_payments WHERE invoice_id=$1',[invoiceId]);check(payments.rows[0]?.count==='1','Serialized payment replay idempotency');
  check(paid[0].body.status==='PAID','Paid only after ledger confirmation');
  check((await database.query<{allowed:boolean}>('SELECT rastreia.unit_accepts_new_operations($1) AS allowed',[unit.id])).rows[0]?.allowed,'Payment releases hold');
  const registration={name:'Entregador teste',email:`${prefix}-courier@example.test`,phone:`+5534${String(Number.parseInt(randomBytes(4).toString('hex'),16)).padStart(10,'0')}`,password,baseCity:'Teste',radiusM:5000,
    modalities:['ONE_OFF'],vehicleType:'MOTORCYCLE',acceptedTerms:true,acceptedPrivacy:true,legalVersion:env.LEGAL_DOCUMENTS_VERSION};
  check((await call('POST','/public/couriers/register',registration)).status===202,'Public courier registration');
  check((await call('POST','/public/couriers/register',registration)).status===202,'Duplicate registration is non-enumerating');
  const user=(await database.query<{id:string}>("SELECT id FROM rastreia.users WHERE email=$1",[registration.email])).rows[0]!;
  check((await call('POST','/auth/sign-in',{email:registration.email,password})).status===401,'Unverified email cannot login');
  const verify=await emailToken(user.id,'VERIFY_EMAIL');check((await call('POST','/public/couriers/verify-email',{token:verify})).status===200,'Email verification');
  const courierIdentity=(await call('POST','/auth/sign-in',{email:registration.email,password})).body;
  check(courierIdentity.units.length===0,'Courier identity independent from tenant');
  const courierToken=courierIdentity.accessToken as string;
  const point={latitude:-18.9,longitude:-48.2,accuracy:10,locationConsent:true};
  check((await call('POST','/courier/availability/start',point,courierToken)).status===403,'Unapproved courier unavailable');
  const reviewed=await call('POST',`/platform/courier-registrations/${courierIdentity.courier.id}/review`,{status:'APPROVED',reason:'Análise sintética aprovada.'},master);
  assert.equal(reviewed.status,200,JSON.stringify(reviewed.body));checks++;
  check((await call('POST','/courier/availability/start',point,courierToken)).status===200,'Approved courier available');
  const profileId=courierIdentity.courier.id as string;
  await database.query("INSERT INTO rastreia.tenant_users(tenant_id,user_id,role) VALUES($1,$2,'COURIER')",[unit.tenant_id,user.id]);
  await database.query("INSERT INTO rastreia.courier_store_links(tenant_id,store_id,courier_profile_id,status) VALUES($1,$2,$3,'ACTIVE')",[unit.tenant_id,unit.id,profileId]);
  await call('POST','/courier/availability/start',point,courierToken);
  const availability=await database.query<{count:string}>("SELECT count(*)::text FROM rastreia.courier_availability WHERE courier_profile_id=$1 AND status='AVAILABLE'",[profileId]);
  check(availability.rows[0]?.count==='1','Global availability reaches existing tenant search pipeline');
  const eligible=await database.query<{allowed:boolean}>("SELECT rastreia.courier_matches_preferences($1,$2,'ONE_OFF',now(),now()+interval '1 hour') AS allowed",[profileId,unit.id]);
  check(eligible.rows[0]?.allowed,'Approved available courier matches city and modality');
  const ineligible=await database.query<{allowed:boolean}>("SELECT rastreia.courier_matches_preferences($1,$2,'FIXED_SHIFT',now(),now()+interval '1 hour') AS allowed",[profileId,unit.id]);
  check(!ineligible.rows[0]?.allowed,'Unwanted modality excludes courier');
  check((await call('POST','/courier/availability/stop',{},courierToken)).status===200,'Courier can stop availability');
  const profile=await call('GET','/courier/profile',undefined,courierToken);check(profile.body.latitude===null&&profile.body.availability_status==='OFFLINE','Offline clears discovery location');
  const stopped=await database.query<{count:string}>("SELECT count(*)::text FROM rastreia.courier_availability WHERE courier_profile_id=$1 AND (status='AVAILABLE' OR latitude IS NOT NULL)",[profileId]);
  check(stopped.rows[0]?.count==='0','Going offline clears all linked tenant discovery snapshots');
  check((await call('GET','/me/invoices',undefined,courierToken)).status===401,'Global courier token cannot read tenant billing');
  const inactive=await call('PATCH',`/platform/stores/${unit.id}/status`,{status:'INACTIVE',reason:'Inativação sintética para verificar sessões.'},master);
  check(inactive.status===200,'Master can inactivate a unit');
  check((await call('GET','/stores',undefined,manager)).status===401,'Old operational access token loses inactive unit access');
  check((await call('POST','/auth/enter-unit',{storeId:unit.id},identity.accessToken as string)).status===401,'Identity cannot enter inactive unit');
  process.stdout.write(JSON.stringify({checks,rollbackOnly:true,requestsSerialized:true,status:'passed'})+'\n');
} finally {
  try { if(app)await app.close(); } finally {
    await connection.query('ROLLBACK');connection.release();await pool.end();
  }
}
