import argon2 from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withPlatformTransaction, type Database } from '../../database/pool.js';
import { emailConfigured } from '../../integrations/email/email.service.js';
import { conflict, notFound } from '../../shared/errors.js';
import { parseIdempotencyKey } from '../../shared/idempotency.js';
import { authenticatePlatform } from '../auth/auth.guard.js';
import type { PlatformAuthContext } from '../auth/auth.types.js';
import { createIdentityAction, passwordOptions } from '../auth/identity.service.js';
import { billingProfileSchema, timezoneSchema } from '../billing/billing.schemas.js';
import { masterAudit, saveBillingProfile } from '../billing/billing.service.js';
import { storeSchema } from '../stores/store.routes.js';
import { withPlatformIdempotency } from './platform-idempotency.js';
import { companySchema, contextFilterSchema } from '../organization/organization.schemas.js';
import { encryptPayload } from '../../shared/encrypted-payload.js';

const managerSchema=z.object({name:z.string().trim().min(2).max(160),email:z.string().trim().email().toLowerCase()});
const tenantSchema=z.object({slug:z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),name:z.string().min(2).max(160),timezone:timezoneSchema.default('America/Sao_Paulo')});
export const provisionUnitSchema=z.object({tenantId:z.string().uuid().optional(),tenant:tenantSchema.optional(),
  companyId:z.string().uuid().optional(),company:companySchema.optional(),
  store:storeSchema,manager:managerSchema,billing:billingProfileSchema,
  limits:z.record(z.string().max(80),z.number().int().min(0).max(1000000)).default({}),
  settings:z.record(z.string().max(80),z.union([z.string().max(240),z.number(),z.boolean()])).default({}),
}).refine(input=>Boolean(input.tenantId)!==Boolean(input.tenant),{message:'Informe uma empresa existente ou uma nova, não ambas.'});

export async function inviteManager(client:PoolClient,env:AppEnv,auth:PlatformAuthContext,tenantId:string,storeId:string|undefined,
  manager:z.infer<typeof managerSchema>,grantUnit=true) {
  // Serialize concurrent provisioning of the same global email without changing its password.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[manager.email]);
  let account=(await client.query('SELECT * FROM rastreia.identity_by_email($1)',[manager.email])).rows[0];
  const isNew=!account;
  if(!account) {
    const id=randomUUID();
    const hash=await argon2.hash(randomBytes(48).toString('base64url'),passwordOptions);
    account=(await client.query(`INSERT INTO users(id,name,email,password_hash,email_verified_at) VALUES($1,$2,$3,$4,NULL)
      RETURNING id,email,status`,[id,manager.name,manager.email,hash])).rows[0];
  }
  if(account.status!=='ACTIVE')throw conflict('A conta existente precisa estar ativa antes do vínculo.');
  const previous=(await client.query('SELECT id,role,status FROM tenant_users WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',[tenantId,account.id])).rows[0];
  if(previous && (previous.role!=='TENANT_MANAGER'||previous.status!=='ACTIVE'))throw conflict('Esta identidade já possui outro papel ou um vínculo bloqueado nesta empresa.');
  if(!previous)await client.query(`INSERT INTO tenant_users(tenant_id,user_id,role) VALUES($1,$2,'TENANT_MANAGER')`,[tenantId,account.id]);
  if(grantUnit&&storeId)await client.query(`INSERT INTO user_access_scopes(tenant_id,user_id,scope_level,company_id,store_id,created_by)
    SELECT $1,$2,'STORE',company_id,id,$4 FROM stores WHERE id=$3 AND tenant_id=$1
    ON CONFLICT(user_id,store_id) WHERE scope_level='STORE' AND status='ACTIVE'
    DO UPDATE SET valid_from=now(),valid_until=NULL`,[tenantId,account.id,storeId,auth.userId]);
  await createIdentityAction(client,env,{userId:account.id,email:manager.email,kind:'INVITE',tenantId,...(storeId?{storeId}:{}),
    requiresPassword:isNew||!account.email_verified_at});
  await masterAudit(client,auth,{action:'organization.manager_invited',entityType:storeId?'store':'tenant',entityId:storeId??tenantId,tenantId,
    after:{userId:account.id},reason:'Provisionamento explícito de gestor pelo Master.'});
  return {id:account.id,emailDelivery:emailConfigured(env)?'queued':'configuration_required'};
}
export async function platformUnitRoutes(app:FastifyInstance,database:Database,env:AppEnv) {
  const auth=authenticatePlatform(env,database);
  app.get('/platform/stores',{preHandler:auth},async request=>withPlatformTransaction(database,request.platformAuth,async client=>{
    const f=contextFilterSchema.parse(request.query);
    const result=await client.query(`SELECT store.*,tenant.name AS tenant_name,company.name AS company_name,profile.id AS billing_profile_id,count(*) OVER()::int AS total_count,
      (hold.blocked_at IS NOT NULL AND hold.released_at IS NULL AND (hold.waiver_until IS NULL OR hold.waiver_until<=now())) AS financially_blocked
      FROM stores store JOIN tenants tenant ON tenant.id=store.tenant_id JOIN companies company ON company.id=store.company_id LEFT JOIN billing_profiles profile ON profile.store_id=store.id
      LEFT JOIN unit_financial_holds hold ON hold.store_id=store.id WHERE ($1::uuid IS NULL OR store.tenant_id=$1)
      AND ($2::uuid IS NULL OR store.company_id=$2) AND ($3::uuid IS NULL OR store.id=$3)
      AND ($4='' OR position(lower($4) in lower(store.name))>0) AND ($5::text IS NULL OR store.status::text=$5)
      ORDER BY tenant.name,company.name,store.name,store.id LIMIT $6 OFFSET $7`,[f.tenantId??null,f.companyId??null,f.storeId??null,f.search,f.status??null,f.limit,f.offset]);return {data:result.rows,total:result.rows[0]?.total_count??0,limit:f.limit,offset:f.offset};
  }));
  app.post('/platform/stores',{preHandler:auth},async(request,reply)=>{
    const input=provisionUnitSchema.parse(request.body);const key=parseIdempotencyKey(request.headers['idempotency-key']);
    const result=await withPlatformTransaction(database,request.platformAuth,client=>withPlatformIdempotency(client,request.platformAuth,key,
      'store.provision',input,async()=>{
        let tenantId=input.tenantId;
        if(!tenantId)tenantId=(await client.query('INSERT INTO tenants(slug,name,timezone) VALUES($1,$2,$3) RETURNING id',
          [input.tenant!.slug,input.tenant!.name,input.tenant!.timezone])).rows[0].id;
        const tenant=(await client.query<{id:string}>("SELECT id FROM tenants WHERE id=$1 AND status='ACTIVE' FOR SHARE",[tenantId])).rows[0];
        if(!tenant)throw conflict('Empresa inativa ou inexistente.');
        if(!input.companyId&&!input.company)throw conflict('Selecione a empresa jurídica ou preencha os dados de uma nova empresa.');
        if(input.companyId&&input.company)throw conflict('Selecione uma empresa existente ou uma nova, não ambas.');
        const companyId=input.companyId??(await client.query<{id:string}>(`INSERT INTO companies(tenant_id,name,legal_name,tax_id_encrypted)
          VALUES($1,$2,$3,$4) RETURNING id`,[tenantId,input.company!.name,input.company!.legalName,
            encryptPayload({taxId:input.company!.taxId},env.MESSAGE_PAYLOAD_SECRET||env.TRACKING_TOKEN_PEPPER)])).rows[0]!.id;
        if(!(await client.query("SELECT id FROM companies WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE' FOR SHARE",[companyId,tenantId])).rowCount)
          throw conflict('Empresa inativa ou não pertencente ao grupo selecionado.');
        const s=input.store;
        const store=(await client.query<{id:string;name:string}>(`INSERT INTO stores(tenant_id,name,external_reference,address_line,address_number,complement,
          neighborhood,city,state,postal_code,latitude,longitude,address_confidence,contact_phone,plan_code,operational_limits,operational_settings,company_id,opening_time,closing_time,operating_weekdays)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19,$20,$21) RETURNING *`,
        [tenantId,s.name,s.externalReference??null,s.addressLine,s.addressNumber??null,s.complement??null,s.neighborhood??null,s.city,s.state,
          s.postalCode??null,s.latitude,s.longitude,s.addressConfidence??null,s.contactPhone??null,input.billing.planCode,
          JSON.stringify(input.limits),JSON.stringify(input.settings),companyId,s.openingTime??null,s.closingTime??null,s.operatingWeekdays])).rows[0]!;
        const manager=await inviteManager(client,env,request.platformAuth,tenant.id,store.id,input.manager);
        await saveBillingProfile(client,env,request.platformAuth,store.id,input.billing,'Dados de faturamento no provisionamento.');
        await masterAudit(client,request.platformAuth,{action:'store.provisioned',entityType:'store',entityId:store.id,tenantId:tenant.id,
          after:{name:store.name,managerId:manager.id,plan:input.billing.planCode},reason:'Unidade, gestor e convite criados na mesma transação.'});
        return {statusCode:201,body:{...store,manager}};
      }));
    reply.header('Idempotency-Replayed',String(result.replayed));return reply.code(result.statusCode).send(result.body);
  });
  app.post('/platform/stores/:id/managers',{preHandler:auth},async(request,reply)=>{
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);const input=managerSchema.parse(request.body);
    const key=parseIdempotencyKey(request.headers['idempotency-key']);
    const result=await withPlatformTransaction(database,request.platformAuth,client=>withPlatformIdempotency(client,request.platformAuth,key,'store.manager',
      {id,...input},async()=>{const store=(await client.query<{tenant_id:string}>('SELECT tenant_id FROM stores WHERE id=$1 FOR UPDATE',[id])).rows[0];
        if(!store)throw notFound();return {statusCode:201,body:await inviteManager(client,env,request.platformAuth,store.tenant_id,id,input)};}));
    return reply.code(result.statusCode).send(result.body);
  });
  app.patch('/platform/stores/:id',{preHandler:auth},async(request,reply)=>{
    const id=z.object({id:z.string().uuid()}).parse(request.params).id;
    const input=z.object({store:storeSchema,billing:billingProfileSchema,billingVersion:z.number().int().positive().optional(),
      updatedAt:z.iso.datetime(),reason:z.string().trim().min(5).max(500)}).parse(request.body);
    const key=parseIdempotencyKey(request.headers['idempotency-key']);
    const result=await withPlatformTransaction(database,request.platformAuth,client=>withPlatformIdempotency(client,request.platformAuth,key,
      'store.edit',{id,...input},async()=>{
        const before=(await client.query<{tenant_id:string;updated_at:Date}>('SELECT * FROM stores WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!before)throw notFound();
        if(new Date(before.updated_at).getTime()!==new Date(input.updatedAt).getTime())throw conflict('Unidade alterada em outra sessão. Recarregue.');
        const s=input.store;
        await client.query(`UPDATE stores SET name=$2,address_line=$3,address_number=$4,complement=$5,neighborhood=$6,city=$7,
          state=$8,postal_code=$9,latitude=$10,longitude=$11,contact_phone=$12,plan_code=$13,address_confidence=$14,
          opening_time=CASE WHEN $18 THEN $15::time ELSE opening_time END,
          closing_time=CASE WHEN $18 THEN $16::time ELSE closing_time END,
          operating_weekdays=CASE WHEN $18 THEN $17::integer[] ELSE operating_weekdays END WHERE id=$1`,
          [id,s.name,s.addressLine,s.addressNumber??null,s.complement??null,s.neighborhood??null,s.city,s.state,s.postalCode??null,
            s.latitude,s.longitude,s.contactPhone??null,input.billing.planCode,s.addressConfidence??null,s.openingTime??null,s.closingTime??null,s.operatingWeekdays,
            s.openingTime!==undefined||s.closingTime!==undefined]);
        await saveBillingProfile(client,env,request.platformAuth,id,input.billing,input.reason,input.billingVersion);
        await masterAudit(client,request.platformAuth,{action:'store.updated',entityType:'store',entityId:id,tenantId:before.tenant_id,
          before,after:s,reason:input.reason});return {statusCode:200,body:{id}};
      }));return reply.code(result.statusCode).send(result.body);
  });
  app.patch('/platform/stores/:id/status',{preHandler:auth},async request=>{
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const input=z.object({status:z.enum(['ACTIVE','INACTIVE']),reason:z.string().trim().min(5).max(500)}).parse(request.body);
    return withPlatformTransaction(database,request.platformAuth,async client=>{
      const before=(await client.query('SELECT tenant_id,status FROM stores WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!before)throw notFound();
      await client.query('UPDATE stores SET status=$2 WHERE id=$1',[id,input.status]);
      await masterAudit(client,request.platformAuth,{action:'store.status_changed',entityType:'store',entityId:id,tenantId:before.tenant_id,
        before:{status:before.status},after:{status:input.status},reason:input.reason});return {id,status:input.status};
    });
  });
}
