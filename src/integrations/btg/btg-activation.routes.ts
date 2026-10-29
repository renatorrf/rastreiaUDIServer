import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withPlatformTransaction, type Database } from '../../database/pool.js';
import { authenticatePlatform } from '../../modules/auth/auth.guard.js';
import { masterAudit } from '../../modules/billing/billing.service.js';
import { encryptPayload } from '../../shared/encrypted-payload.js';
import { AppError, conflict, notFound } from '../../shared/errors.js';
import { BTG_PIX_WEBHOOK } from './btg.webhook.js';

const confirmation = {confirmationPassword:z.string().min(1).max(200),reason:z.string().trim().min(5).max(300)};
export const applicationInput=z.object({name:z.string().trim().min(2).max(100),mode:z.enum(['sandbox','production']),
 clientId:z.string().trim().min(1).max(200),clientSecret:z.string().trim().min(1).max(2048),
 webhookId:z.uuid().nullable().default(null),webhookSecret:z.string().regex(/^[\x21-\x7e]{32,2048}$/).optional(),
 ...confirmation}).strict().refine(v=>Boolean(v.webhookId)===Boolean(v.webhookSecret),{message:'Informe o ID e o segredo do webhook juntos.'});
export const activationInput=z.object({applicationId:z.uuid(),pixKey:z.string().trim().max(140),
 enabled:z.boolean(),expectedVersion:z.number().int().nonnegative(),...confirmation}).strict();

export async function btgActivationRoutes(app:FastifyInstance,db:Database,env:AppEnv){
 const auth=authenticatePlatform(env,db);
 const confirm=async(request:Parameters<ReturnType<typeof authenticatePlatform>>[0])=>{
  const {confirmationPassword}=z.object(confirmation).parse(request.body);
  const valid=await withPlatformTransaction(db,request.platformAuth,async c=>{
   const row=(await c.query<{password_hash:string}>("SELECT password_hash FROM platform_admins WHERE id=$1 AND status='ACTIVE'",[request.platformAuth.userId])).rows[0];
   return row?argon2.verify(row.password_hash,confirmationPassword).catch(()=>false):false;
  });
  if(!valid)throw new AppError(403,'CONFIRMATION_PASSWORD_INVALID','Confirme sua senha atual do acesso master.');
 };
 const writeOptions={preHandler:[auth,confirm],config:{rateLimit:{max:5,timeWindow:'1 minute'}}};
 app.get('/platform/btg/activation',{preHandler:auth},async(request,reply)=>{
  reply.header('Cache-Control','no-store');
  const {search,offset}=z.object({search:z.string().trim().max(120).default(''),offset:z.coerce.number().int().min(0).max(100000).default(0)}).parse(request.query);
  return withPlatformTransaction(db,request.platformAuth,async c=>{
   const applications=(await c.query(`SELECT id,name,mode,client_id AS "clientId",webhook_id AS "webhookId",created_at AS "createdAt"
    FROM btg_platform_applications ORDER BY created_at DESC LIMIT 100`)).rows;
   const companies=(await c.query(`SELECT c.id,c.name,c.tenant_id AS "tenantId",c.status,
    coalesce(s.version,0) AS version,coalesce(s.enabled,false) AS enabled,
    s.public_config->>'platformApplicationId' AS "applicationId",coalesce(s.public_config->>'activationPixKey',s.public_config->>'pixKey','') AS "pixKey",
    CASE WHEN s.id IS NULL THEN 'NOT_CONFIGURED' WHEN NOT s.enabled THEN 'DISABLED'
     ELSE btg_activation_authorization(c.id,coalesce(a.mode,s.public_config->>'mode'),s.version) END AS "authorizationStatus",
    CASE WHEN a.id IS NOT NULL THEN 'PLATFORM' WHEN s.id IS NOT NULL THEN 'LEGACY' ELSE 'NONE' END AS source,
    btg_activation_has_pending(c.id) AS "hasPendingPayments",count(*) OVER()::int AS total
    FROM companies c LEFT JOIN company_service_settings s ON s.company_id=c.id AND s.provider='BTG'
    LEFT JOIN btg_platform_applications a ON a.id::text=s.public_config->>'platformApplicationId'
    WHERE ($1='' OR position(lower($1) in lower(c.name))>0) ORDER BY c.name,c.id LIMIT 30 OFFSET $2`,[search,offset])).rows;
   return {applications,companies,total:companies[0]?.total??0,offset,
    redirectUri:env.BTG_REDIRECT_URI,webhookUrl:env.BTG_REDIRECT_URI?new URL(BTG_PIX_WEBHOOK,env.BTG_REDIRECT_URI).toString():'',
    infrastructureReady:Boolean(env.BTG_ENABLED&&env.BTG_REDIRECT_URI&&env.BTG_ENCRYPTION_SECRET.length>=32)};
  });
 });
 app.post('/platform/btg/applications',writeOptions,async(request,reply)=>{
  reply.header('Cache-Control','no-store');const v=applicationInput.parse(request.body);
  if(env.BTG_ENCRYPTION_SECRET.length<32)throw new AppError(409,'BTG_NOT_CONFIGURED','Configure a chave de proteção BTG no servidor.');
  return withPlatformTransaction(db,request.platformAuth,async c=>{
   // Serializes webhook reservation against other application creations and binding.
   await c.query("SELECT pg_advisory_xact_lock(hashtext('btg-platform-activation'))");
   if(v.webhookId){
    const used=await c.query(`SELECT 1 FROM company_service_settings WHERE provider='BTG' AND lower(public_config->>'webhookId')=$1
     UNION ALL SELECT 1 FROM btg_platform_applications WHERE webhook_id=$1::uuid`,[v.webhookId.toLowerCase()]);
    if(used.rowCount)throw conflict('Este webhook já está cadastrado. Use o aplicativo existente ou um novo webhook.');
   }
   const encrypted=encryptPayload({clientSecret:v.clientSecret,webhookSecret:v.webhookSecret??''},env.BTG_ENCRYPTION_SECRET);
   const result=(await c.query<{id:string}>(`INSERT INTO btg_platform_applications(name,mode,client_id,secrets_encrypted,webhook_id,created_by)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[v.name,v.mode,v.clientId,encrypted,v.webhookId,request.platformAuth.userId])).rows[0]!;
   await masterAudit(c,request.platformAuth,{action:'btg.application.created',entityType:'btg_application',entityId:result.id,
    after:{name:v.name,mode:v.mode,webhookConfigured:!!v.webhookId},reason:v.reason});
   return result;
  }).then(result=>reply.code(201).send(result));
 });
 app.put('/platform/btg/companies/:id',writeOptions,async(request,reply)=>{
  reply.header('Cache-Control','no-store');const {id}=z.object({id:z.uuid()}).parse(request.params);const v=activationInput.parse(request.body);
  return withPlatformTransaction(db,request.platformAuth,async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtext('btg-platform-activation'))");
   const company=(await c.query<{tenant_id:string;status:string}>('SELECT tenant_id,status FROM companies WHERE id=$1',[id])).rows[0];
   if(!company)throw notFound();
   if(company.status!=='ACTIVE')throw conflict('Ative a empresa antes de configurar a integração.');
   // Checkout/approval lock stores too: no new payment can appear between the check and the binding.
   await c.query('SELECT id FROM stores WHERE company_id=$1 ORDER BY id FOR UPDATE',[id]);
   const old=(await c.query<{version:number}>("SELECT version FROM company_service_settings WHERE company_id=$1 AND provider='BTG' FOR UPDATE",[id])).rows[0];
   if((old?.version??0)!==v.expectedVersion)throw conflict('Configuração alterada. Atualize antes de salvar.');
   if((await c.query<{pending:boolean}>('SELECT btg_activation_has_pending($1) AS pending',[id])).rows[0]?.pending)
    throw conflict('Existem Pix pendentes ou devoluções em conferência. Concilie antes de alterar a conexão.');
   if(!(await c.query('SELECT id FROM btg_platform_applications WHERE id=$1',[v.applicationId])).rowCount)throw notFound('Aplicação não encontrada.');
   // Preserve legacy credential ciphertext and public data for an audited future rollback.
   const metadata=JSON.stringify({platformApplicationId:v.applicationId,activationPixKey:v.pixKey});
   const row=(await c.query<{version:number}>(`INSERT INTO company_service_settings(tenant_id,company_id,provider,enabled,public_config)
    VALUES($1,$2,'BTG',$3,$4::jsonb) ON CONFLICT(company_id,provider) DO UPDATE SET
    public_config=company_service_settings.public_config||EXCLUDED.public_config,enabled=EXCLUDED.enabled,
    version=company_service_settings.version+1,updated_at=now() RETURNING version`,[company.tenant_id,id,v.enabled,metadata])).rows[0]!;
   await masterAudit(c,request.platformAuth,{action:'btg.company.bound',entityType:'company',entityId:id,tenantId:company.tenant_id,
    after:{applicationId:v.applicationId,enabled:v.enabled,version:row.version},reason:v.reason});
   return {version:row.version,status:v.enabled?'AWAITING_AUTHORIZATION':'DISABLED'};
  });
 });
}
