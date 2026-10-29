import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { afterAll,beforeAll,describe,it,expect,vi } from 'vitest';
import type { Database } from '../../database/pool.js';
import type { AppEnv } from '../../config/env.js';
import { encryptPayload } from '../../shared/encrypted-payload.js';
import { safeCompanyService } from '../../modules/company-settings/company-settings.service.js';
import { BTG_PIX_WEBHOOK,btgWebhookRoutes,createBtgWebhookStore,type BtgWebhookStore } from './btg.webhook.js';

const secret='test-webhook-secret-32-characters-only';
const env={BTG_ENABLED:true,BTG_ENCRYPTION_SECRET:'test-encryption-key-not-real-32-characters'} as AppEnv;
const webhookId=randomUUID(),companyId=randomUUID();
const payload={webhookId,event:'instant-collection.paid',data:{id:'charge-a',txId:'tx-a',status:'PAID' as const,pixKey:'pix-a',location:{id:'location-a'},payee:{taxId:'12345678000199'},paidAmount:57.5,paidAt:'2026-10-27T12:00:00Z'}};
async function fixture(){
 const store:BtgWebhookStore={configuration:vi.fn(async()=>({companyId,secret})),enqueue:vi.fn(async()=>{})};
 const app=Fastify();await btgWebhookRoutes(app,{} as Database,env,store);
 const send=(body:unknown=payload,authorization='Bearer '+secret)=>app.inject({method:'POST',url:BTG_PIX_WEBHOOK,headers:{authorization},payload:body as object});
 return {app,store,send};
}
describe('BTG Pix webhook HTTP contract',()=>{
 it('accepts the documented event, returns 200, and only queues reconciliation',async()=>{const f=await fixture();try{const r=await f.send();expect(r.statusCode).toBe(200);expect(r.json()).toEqual({received:true});expect(f.store.enqueue).toHaveBeenCalledWith(companyId,webhookId,expect.objectContaining({id:'charge-a',txId:'tx-a'}));expect(JSON.stringify(vi.mocked(f.store.enqueue).mock.calls)).not.toContain('paidAmount');}finally{await f.app.close();}});
 it.each(['','Bearer wrong','Basic '+secret,'Bearer '+'x'.repeat(40)])('rejects invalid authentication %s',async value=>{const f=await fixture();try{expect((await f.send(payload,value)).statusCode).toBe(401);expect(f.store.enqueue).not.toHaveBeenCalled();}finally{await f.app.close();}});
 it('rejects unknown webhook IDs without leaking company details',async()=>{const f=await fixture();try{vi.mocked(f.store.configuration).mockResolvedValue(null);const r=await f.send();expect(r.statusCode).toBe(401);expect(r.body).not.toContain(companyId);}finally{await f.app.close();}});
 it('acknowledges unrelated authenticated events without enqueuing',async()=>{const f=await fixture();try{expect((await f.send({...payload,event:'instant-collection.unlinked',data:{}})).statusCode).toBe(200);expect(f.store.enqueue).not.toHaveBeenCalled();}finally{await f.app.close();}});
 it('rejects malformed paid payload and oversized body',async()=>{const f=await fixture();try{expect((await f.send({...payload,data:{id:'charge-a'}})).statusCode).toBe(400);expect((await f.send({...payload,extra:'a'.repeat(40000)})).statusCode).toBe(413);expect(f.store.enqueue).not.toHaveBeenCalled();}finally{await f.app.close();}});
 it('returns retryable 503 on persistence failure, never 200 before commit',async()=>{const f=await fixture();try{vi.mocked(f.store.enqueue).mockRejectedValue(new Error('private-database-info'));const r=await f.send();expect(r.statusCode).toBe(503);expect(r.body).not.toContain('private-database-info');}finally{await f.app.close();}});
 it('fails closed when BTG is disabled',async()=>{const app=Fastify();await btgWebhookRoutes(app,{} as Database,{...env,BTG_ENABLED:false});try{expect((await app.inject({method:'POST',url:BTG_PIX_WEBHOOK,payload})).statusCode).toBe(503);}finally{await app.close();}});
 it('never exposes the company webhook secret in the settings DTO',()=>{expect(safeCompanyService({provider:'BTG',enabled:true,source:'company',values:{clientId:'app',clientSecret:'private-client',webhookSecret:secret}})).toMatchObject({publicConfig:{clientId:'app'},configuredSecrets:['clientSecret','webhookSecret']});});
});

describe('BTG webhook persistence and tenant isolation',()=>{
 const pg=new PGlite();const orderId=randomUUID(),otherCompany=randomUUID();
 const query=async(sql:string,values?:unknown[])=>{const r=await pg.query(sql,values);return {...r,rowCount:Math.max(r.affectedRows??0,r.rows.length)};};
 const db={query,connect:async()=>({query,release:()=>{}})} as unknown as Database;
 const store=createBtgWebhookStore(db,env);
 beforeAll(async()=>{
  await pg.exec(`CREATE SCHEMA rastreia;SET search_path=rastreia,public;CREATE ROLE rastreia_runtime;
   CREATE TABLE companies(id uuid PRIMARY KEY,tenant_id uuid,status text DEFAULT 'ACTIVE');
   CREATE TABLE company_service_settings(company_id uuid,tenant_id uuid,provider text,enabled boolean,public_config jsonb,secret_config_encrypted text,version integer DEFAULT 1);
   CREATE TABLE commerce_pix_payments(order_id uuid PRIMARY KEY,company_id uuid,tax_id text,pix_key text,provider_id text,tx_id text,location_id text,paid_at timestamptz,created_at timestamptz DEFAULT now(),next_check_at timestamptz,settings_version integer DEFAULT 1);
  `);
  await pg.exec('BEGIN;'+await readFile(new URL('../../../migrations/0069_btg_pix_webhook.sql',import.meta.url),'utf8')+'COMMIT');
  await query('INSERT INTO companies(id,tenant_id) VALUES($1,$1),($2,$2)',[companyId,otherCompany]);
  await query("INSERT INTO company_service_settings(company_id,tenant_id,provider,enabled,public_config,secret_config_encrypted) VALUES($1,$1,'BTG',true,$2,$3)",[companyId,JSON.stringify({webhookId,mode:'production'}),encryptPayload({webhookSecret:secret},env.BTG_ENCRYPTION_SECRET)]);
  await query("INSERT INTO commerce_pix_payments(order_id,company_id,tax_id,pix_key,provider_id,tx_id,location_id,next_check_at) VALUES($1,$2,'12345678000199','pix-a','charge-a','tx-a','location-a',now()+interval '10 minutes')",[orderId,companyId]);
 },30000);
 afterAll(()=>pg.close());
 it('resolves only the registered active production company configuration',async()=>{expect(await store.configuration(webhookId)).toEqual({companyId,secret});expect(await store.configuration(randomUUID())).toBeNull();});
 it('does not queue another company or different receiver',async()=>{
  await store.enqueue(otherCompany,webhookId,payload.data);await store.enqueue(companyId,webhookId,{...payload.data,payee:{taxId:'99999999000199'}});
  expect((await query('SELECT * FROM btg_pix_webhook_receipts')).rowCount).toBe(0);
 });
 it('persists one receipt, schedules polling, and duplicate notifications do not reset backoff',async()=>{
  await store.enqueue(companyId,webhookId,payload.data);
  expect((await query('SELECT next_check_at<=now() AS due,paid_at FROM commerce_pix_payments')).rows[0]).toEqual({due:true,paid_at:null});
  await query("UPDATE commerce_pix_payments SET next_check_at=now()+interval '10 minutes'");await store.enqueue(companyId,webhookId,payload.data);
  expect((await query('SELECT * FROM btg_pix_webhook_receipts')).rowCount).toBe(1);expect((await query('SELECT next_check_at>now() AS future FROM commerce_pix_payments')).rows[0]).toEqual({future:true});
 });
 it('does not grant runtime access to webhook receipts',async()=>{expect((await query("SELECT has_table_privilege('rastreia_runtime','rastreia.btg_pix_webhook_receipts','SELECT') AS allowed")).rows[0]).toEqual({allowed:false});});
 it('routes a shared application webhook by saved charge and binding, never by arbitrary company tags',async()=>{
  const applicationId=randomUUID(),centralWebhook=randomUUID();
  await pg.exec('CREATE TABLE btg_platform_applications(id uuid PRIMARY KEY,mode text,webhook_id uuid,secrets_encrypted text)');
  await query("INSERT INTO btg_platform_applications VALUES($1,'production',$2,$3)",[applicationId,centralWebhook,encryptPayload({webhookSecret:secret},env.BTG_ENCRYPTION_SECRET)]);
  await query("UPDATE company_service_settings SET public_config=public_config||jsonb_build_object('platformApplicationId',$1::text)",[applicationId]);
  expect(await store.configuration(webhookId)).toBeNull();
  expect(await store.configuration(centralWebhook)).toEqual({companyId:'',applicationId,secret});
  await query('DELETE FROM btg_pix_webhook_receipts');
  await store.enqueue('',centralWebhook,payload.data,randomUUID());expect((await query('SELECT * FROM btg_pix_webhook_receipts')).rowCount).toBe(0);
  await store.enqueue('',centralWebhook,{...payload.data,payee:{taxId:'99999999000199'}},applicationId);expect((await query('SELECT * FROM btg_pix_webhook_receipts')).rowCount).toBe(0);
  await store.enqueue('',centralWebhook,payload.data,applicationId);expect((await query('SELECT company_id FROM btg_pix_webhook_receipts')).rows).toEqual([{company_id:companyId}]);
 });
 it('rejects a shared event if the payment belongs to a previous connection version',async()=>{
  const row=(await pg.query<{id:string;webhook_id:string}>('SELECT id,webhook_id FROM btg_platform_applications')).rows[0]!;await query('DELETE FROM btg_pix_webhook_receipts');
  await query('UPDATE company_service_settings SET version=2');
  await store.enqueue('',row.webhook_id,payload.data,row.id);expect((await query('SELECT * FROM btg_pix_webhook_receipts')).rowCount).toBe(0);
 });
});
