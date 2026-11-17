import { randomUUID, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../database/pool.js';
import type { PoolClient } from 'pg';
import { parseAppEnv } from '../../config/env.js';
import { decryptPayload } from '../../shared/encrypted-payload.js';
import { processStartedWhatsApp, queueStartedWhatsApp, queueAutomaticStartedWhatsApp, whatsappRecipient } from './tracking-whatsapp.service.js';
import { communicationWebhookRoutes } from './webhook.routes.js';

// Only ephemeral PostgreSQL and mocked HTTP. Never reads .env or sends to Meta.
describe('Automatic tracking WhatsApp', () => {
  let pg: PGlite; let db: Database; let client: PoolClient;
  const tenant=randomUUID(),otherTenant=randomUUID(),company=randomUUID(),store=randomUUID();
  const env=parseAppEnv({NODE_ENV:'test',DATABASE_URL:'postgres://test:test@localhost/test',
    JWT_ACCESS_SECRET:'a'.repeat(48),JWT_REFRESH_SECRET:'b'.repeat(48),TRACKING_TOKEN_PEPPER:'c'.repeat(48),
    MESSAGE_PAYLOAD_SECRET:'d'.repeat(48),PUBLIC_TRACKING_BASE_URL:'https://rastreiaudi.web.app/rastrear',
    WHATSAPP_AUTOMATIC_TRACKING_ENABLED:'true',WHATSAPP_PHONE_NUMBER_ID:'123456789',
    WHATSAPP_ACCESS_TOKEN:'test-only',WHATSAPP_APP_SECRET:'test-signature-secret',COMMUNICATIONS_MOCK:'false'});
  const post=vi.fn(); let id:string;
  beforeAll(async()=>{
    pg=new PGlite();
    const query=async(sql:string,params:unknown[]=[])=>{
      const result=await pg.query(sql,params);return {...result,rowCount:result.affectedRows||result.rows.length};
    };
    client={query,release:()=>{}} as unknown as PoolClient;
    db={query,connect:async()=>client} as unknown as Database;
    await pg.exec(`CREATE SCHEMA rastreia; SET search_path=rastreia,public;
      CREATE TYPE message_delivery_status AS ENUM('PENDING','PROCESSING','RETRYING','SENT','DELIVERED','FAILED');
      CREATE TABLE tenants(id uuid PRIMARY KEY,status text DEFAULT 'ACTIVE');
      CREATE TABLE companies(id uuid PRIMARY KEY,tenant_id uuid,status text DEFAULT 'ACTIVE');
      CREATE TABLE stores(id uuid PRIMARY KEY,tenant_id uuid,company_id uuid,name text,status text DEFAULT 'ACTIVE');
      CREATE TABLE deliveries(id uuid PRIMARY KEY,tenant_id uuid,company_id uuid,store_id uuid,status text,
        recipient_name text,recipient_phone text,recipient_whatsapp text,external_reference text,courier_profile_id uuid,out_for_delivery_at timestamptz);
      CREATE TABLE tracking_tokens(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,delivery_id uuid,
        token_hash text,expires_at timestamptz,created_by uuid,revoked_at timestamptz);
      CREATE UNIQUE INDEX tracking_tokens_active_delivery_idx ON tracking_tokens(tenant_id,delivery_id) WHERE revoked_at IS NULL;
      CREATE TABLE message_deliveries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,delivery_id uuid,channel text,
        status message_delivery_status DEFAULT 'PENDING',destination_masked text,encrypted_payload text,created_by uuid,
        provider_message_id text,attempt_count int DEFAULT 0,sent_at timestamptz,delivered_at timestamptz,failed_at timestamptz,
        last_error_code text,last_error_message text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
        next_attempt_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX message_deliveries_pending_idx ON message_deliveries(status,next_attempt_at) WHERE status IN ('PENDING','RETRYING');
      CREATE TABLE outbox_events(tenant_id uuid,aggregate_type text,aggregate_id uuid,event_type text,payload jsonb);
      CREATE TABLE audit_logs(tenant_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,ip inet);
      CREATE TABLE notification_attempts(tenant_id uuid,channel text,message_delivery_id uuid,attempt_number int,success boolean,provider_status int,provider_message_id text,error_code text);
      CREATE TABLE message_webhook_receipts(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,provider text,provider_event_id text,payload_hash text,UNIQUE(provider,provider_event_id));`);
    await pg.exec('BEGIN;'+await readFile(new URL('../../../migrations/0072_automatic_tracking_whatsapp.sql',import.meta.url),'utf8')+'COMMIT;');
    await pg.query('INSERT INTO tenants(id) VALUES($1)',[tenant]);
    await pg.query('INSERT INTO companies(id,tenant_id) VALUES($1,$2)',[company,tenant]);
    await pg.query("INSERT INTO stores(id,tenant_id,company_id,name) VALUES($1,$2,$3,'Loja teste')",[store,tenant,company]);
  },30000);
  beforeEach(async()=>{
    vi.stubGlobal('fetch',post);post.mockReset();
    post.mockResolvedValue(new Response(JSON.stringify({messages:[{id:'wamid.'+randomUUID()}]}),{status:200}));
    await pg.exec("UPDATE stores SET status='ACTIVE'; UPDATE companies SET status='ACTIVE'; UPDATE tenants SET status='ACTIVE';");
    id=randomUUID();
    await pg.query(`INSERT INTO deliveries VALUES($1,$2,$3,$4,'IN_ROUTE','João da Silva','34999991234',NULL,'Pedido-42',$5,now())`,[id,tenant,company,store,randomUUID()]);
  });
  afterAll(async()=>{vi.unstubAllGlobals();await pg?.close();});
  const queue=(retry=false)=>queueStartedWhatsApp(client,env,{tenantId:tenant,deliveryId:id,source:'MANUAL',actorId:null,retry});
  const auto=(type='delivery.start',occurred_at=new Date())=>queueAutomaticStartedWhatsApp(db,env,{tenant_id:tenant,aggregate_id:id,event_type:type,occurred_at});
  const latest=async()=> (await pg.query<{id:string;status:string;last_error_code:string;encrypted_payload:string;tracking_token_id:string;provider_message_id:string}>(
    'SELECT * FROM message_deliveries WHERE delivery_id=$1',[id])).rows[0]!;
  it('normalizes DDI without guessing a recipient or accepting relay/extensions',()=>{
    expect(whatsappRecipient('+55 (34) 99999-9565')).toBe('5534999999565');
    expect(whatsappRecipient('34999999565')).toBe('5534999999565');
    for(const value of ['', '08001234567','3499999565','+1 212 5551234','34999991234 ramal 1','00999991234']) expect(whatsappRecipient(value)).toBeNull();
  });
  it('starts once for individual/batch delivery.start, no duplicates with manual or repeated events',async()=>{
    await auto();await auto();const reply=await queue();expect(reply?.reused).toBe(true);
    expect(JSON.stringify(reply)).not.toContain('encrypted_payload');
    const m=await latest();await processStartedWhatsApp(db,env,tenant,m.id);await processStartedWhatsApp(db,env,tenant,m.id);
    expect(post).toHaveBeenCalledTimes(1);expect((await latest()).status).toBe('SENT');
    const body=JSON.parse(String(post.mock.calls[0]![1].body)) as {to:string;template:{name:string;components:Array<{parameters:Array<{text:string}>}>};biz_opaque_callback_data:string};
    expect(body.to).toBe('5534999991234');expect(body.template.name).toBe('rastreia_app_pedido');
    expect(body.template.components[0]!.parameters.map(p=>p.text)).toEqual([
      'João','Pedido-42','Loja teste',expect.stringContaining('https://rastreiaudi.web.app/rastrear/'),'https://rastreiaudi.web.app/cliente']);
    expect(body.biz_opaque_callback_data).toBe(m.id);
    expect((await pg.query('SELECT * FROM outbox_events WHERE aggregate_id=$1',[m.id])).rows).toHaveLength(1);
    await expect(pg.query(`INSERT INTO message_deliveries(tenant_id,delivery_id,channel,purpose) VALUES($1,$2,'WHATSAPP','DELIVERY_STARTED')`,[tenant,id])).rejects.toThrow();
  });
  it('does not trigger on creation, assignment, collection, next stop, completion or stale departure',async()=>{
    for(const type of ['delivery.created','delivery.assigned','delivery.collect','delivery.next-stop','delivery.complete'])await auto(type);
    await auto('delivery.start',new Date(Date.now()-31*60_000));
    expect(await latest()).toBeUndefined();expect(post).not.toHaveBeenCalled();
  });
  it('includes the first destination of a batch marked NEXT_STOP',async()=>{
    await pg.query("UPDATE deliveries SET status='NEXT_STOP' WHERE id=$1",[id]);await auto();
    await processStartedWhatsApp(db,env,tenant,(await latest()).id);expect(post).toHaveBeenCalledTimes(1);
  });
  it.each(['stores','companies','tenants'])('blocks deactivated %s before sending',async table=>{
    await auto();await pg.exec(`UPDATE ${table} SET status='INACTIVE'`);
    await processStartedWhatsApp(db,env,tenant,(await latest()).id);
    expect((await latest()).last_error_code).toBe('OPERATION_INACTIVE');expect(post).not.toHaveBeenCalled();
  });
  it('records missing global configuration instead of using a company sender',async()=>{
    await queueStartedWhatsApp(client,{...env,WHATSAPP_ACCESS_TOKEN:''},{tenantId:tenant,deliveryId:id,source:'AUTOMATIC',actorId:null});
    expect(await latest()).toMatchObject({status:'SKIPPED',last_error_code:'WHATSAPP_NOT_CONFIGURED',tracking_token_id:null});
    expect(post).not.toHaveBeenCalled();
  });
  it.each([200,500])('does not retry ambiguous HTTP %s responses without a message id',async status=>{
    await queue();post.mockResolvedValueOnce(new Response('{}',{status}));
    await processStartedWhatsApp(db,env,tenant,(await latest()).id);
    await processStartedWhatsApp(db,env,tenant,(await latest()).id);
    expect((await latest()).status).toBe('UNKNOWN');expect(post).toHaveBeenCalledTimes(1);
  });
  it('is opt-in and never routes through another company credentials',async()=>{
    await queueAutomaticStartedWhatsApp(db,{...env,WHATSAPP_AUTOMATIC_TRACKING_ENABLED:false},
      {tenant_id:tenant,aggregate_id:id,event_type:'delivery.start',occurred_at:new Date()});
    expect(await latest()).toBeUndefined();await queue();const m=await latest();
    await processStartedWhatsApp(db,env,otherTenant,m.id);expect(post).not.toHaveBeenCalled();
    await processStartedWhatsApp(db,env,tenant,m.id);
    expect(post.mock.calls[0]![0]).toContain('/123456789/messages');
  });
  it('records missing iFood phone, no token or send; manual cannot notify a pending order',async()=>{
    await pg.query("UPDATE deliveries SET recipient_phone='',recipient_whatsapp=NULL WHERE id=$1",[id]);await auto();
    expect(await latest()).toMatchObject({status:'SKIPPED',last_error_code:'RECIPIENT_INVALID',tracking_token_id:null});
    await pg.query("UPDATE deliveries SET recipient_phone='34999991234',status='AWAITING_PICKUP' WHERE id=$1",[id]);
    await expect(queue(true)).rejects.toMatchObject({code:'DELIVERY_NOT_IN_ROUTE'});expect(post).not.toHaveBeenCalled();
  });
  it.each(['DELIVERED','CANCELLED','DELIVERY_FAILED','RETURN_STARTED'])('suppresses delayed notification after %s',async status=>{
    await auto();const m=await latest();await pg.query('UPDATE deliveries SET status=$2 WHERE id=$1',[id,status]);
    await processStartedWhatsApp(db,env,tenant,m.id);expect((await latest()).status).toBe('SKIPPED');expect(post).not.toHaveBeenCalled();
  });
  it('does not revoke previously shared links and stops after explicit revocation',async()=>{
    const old=randomUUID();await pg.query("INSERT INTO tracking_tokens(id,tenant_id,delivery_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[old,tenant,id]);
    await auto();expect((await pg.query<{revoked_at:null}>('SELECT revoked_at FROM tracking_tokens WHERE id=$1',[old])).rows[0]!.revoked_at).toBeNull();
    await pg.query('UPDATE tracking_tokens SET revoked_at=now() WHERE delivery_id=$1',[id]);
    await processStartedWhatsApp(db,env,tenant,(await latest()).id);expect((await latest()).last_error_code).toBe('TRACKING_REVOKED_OR_EXPIRED');expect(post).not.toHaveBeenCalled();
  });
  it('rechecks destination and company before dispatch',async()=>{
    await auto();await pg.query("UPDATE deliveries SET recipient_whatsapp='11999991234' WHERE id=$1",[id]);
    await processStartedWhatsApp(db,env,tenant,(await latest()).id);expect((await latest()).last_error_code).toBe('RECIPIENT_CHANGED');expect(post).not.toHaveBeenCalled();
  });
  it('does not resend ambiguous timeout or a recovered PROCESSING lease',async()=>{
    await queue();const m=await latest();post.mockRejectedValue(new Error('timeout'));
    await processStartedWhatsApp(db,env,tenant,m.id);await processStartedWhatsApp(db,env,tenant,m.id);await queue(true);
    expect((await latest()).status).toBe('UNKNOWN');expect(post).toHaveBeenCalledTimes(1);
    await pg.query("UPDATE message_deliveries SET status='PROCESSING' WHERE id=$1",[m.id]);
    await processStartedWhatsApp(db,env,tenant,m.id);expect(post).toHaveBeenCalledTimes(1);expect((await latest()).status).toBe('UNKNOWN');
  });
  it('only retries explicit rate-limit rejection; invalid template needs manual review',async()=>{
    await queue();const m=await latest();post.mockResolvedValueOnce(new Response('{}',{status:429}));
    await expect(processStartedWhatsApp(db,env,tenant,m.id)).rejects.toThrow('WHATSAPP_RATE_LIMIT');
    expect((await latest()).status).toBe('RETRYING');
    post.mockResolvedValueOnce(new Response(JSON.stringify({error:{code:132000}}),{status:400}));
    await processStartedWhatsApp(db,env,tenant,m.id);expect((await latest()).status).toBe('FAILED');
    await processStartedWhatsApp(db,env,tenant,m.id);expect(post).toHaveBeenCalledTimes(2);
    await queue(true);expect((await latest()).status).toBe('PENDING');
  });
  it('stores sensitive recipient and token only in encrypted payload',async()=>{
    await auto();const m=await latest();expect(m.encrypted_payload).not.toContain('34999991234');
    const payload=decryptPayload<{trackingUrl:string}>(m.encrypted_payload,env.MESSAGE_PAYLOAD_SECRET);
    const events=JSON.stringify((await pg.query('SELECT * FROM outbox_events WHERE aggregate_id=$1',[m.id])).rows);
    expect(events).not.toContain(payload.trackingUrl);expect(events).not.toContain('34999991234');
  });
  it('accepts signed webhook, correlates uncertain submission and never regresses delivered to sent',async()=>{
    await queue();const m=await latest();post.mockRejectedValueOnce(new Error('timeout'));
    await processStartedWhatsApp(db,env,tenant,m.id);
    const app=Fastify();await app.register(rawBody,{global:false});await communicationWebhookRoutes(app,db,env);
    const notify=async(status:string,phone='123456789',signed=true)=>{
      const payload=JSON.stringify({entry:[{changes:[{value:{metadata:{phone_number_id:phone},statuses:[{
        id:'wamid.webhook',status,timestamp:'123',biz_opaque_callback_data:m.id}]} }]}]});
      return app.inject({method:'POST',url:'/webhooks/whatsapp',payload,headers:{'content-type':'application/json',
        'x-hub-signature-256':signed?'sha256='+createHmac('sha256',env.WHATSAPP_APP_SECRET).update(payload).digest('hex'):'invalid'}});
    };
    expect((await notify('delivered','other')).statusCode).toBe(200);expect((await latest()).status).toBe('UNKNOWN');
    expect((await notify('delivered','123456789',false)).statusCode).not.toBe(200);
    expect((await notify('delivered')).statusCode).toBe(200);await notify('sent');await notify('failed');await notify('delivered');
    expect((await latest()).status).toBe('DELIVERED');expect(post).toHaveBeenCalledTimes(1);await app.close();
  });
});
