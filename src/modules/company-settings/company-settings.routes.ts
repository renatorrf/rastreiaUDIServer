import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withTenantTransaction,type Database } from '../../database/pool.js';
import { forbidden,notFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { authenticate,requireRoles } from '../auth/auth.guard.js';
import { confirmationPasswordSchema,confirmManagerPassword } from '../auth/confirm-manager-password.js';
import { companyProviders,resolveCompanyService,safeCompanyService,saveCompanyService } from './company-settings.service.js';

const id=z.object({id:z.uuid()});
const provider=z.enum(companyProviders);
const common=z.object({enabled:z.boolean(),provider});
const schemas={
  WEB_PUSH:common.extend({provider:z.literal('WEB_PUSH'),publicConfig:z.object({subject:z.string().trim().max(240),publicKey:z.string().trim().max(512),
    appUrl:z.union([z.literal(''),z.url()]),iconUrl:z.union([z.literal(''),z.url()]),badgeUrl:z.union([z.literal(''),z.url()])}),secrets:z.object({privateKey:z.string().trim().max(512).default('')})}),
  WHATSAPP:common.extend({provider:z.literal('WHATSAPP'),publicConfig:z.object({phoneNumberId:z.string().trim().max(100),businessAccountId:z.string().trim().max(100),
    graphVersion:z.string().trim().regex(/^v\d+\.\d+$/),trackingTemplate:z.string().trim().max(120),templateLanguage:z.string().trim().max(20)}),
    secrets:z.object({accessToken:z.string().trim().max(4096).default(''),webhookVerifyToken:z.string().trim().max(512).default(''),appSecret:z.string().trim().max(512).default('')})}),
  SMS:common.extend({provider:z.literal('SMS'),publicConfig:z.object({provider:z.enum(['','webhook']),apiUrl:z.union([z.literal(''),z.url()])}),
    secrets:z.object({apiKey:z.string().trim().max(2048).default('')})}),
  IFOOD:common.extend({provider:z.literal('IFOOD'),publicConfig:z.object({mode:z.enum(['mock','sandbox','production']),baseUrl:z.url(),eventsMode:z.enum(['polling','webhook']),
    webhookEnabled:z.boolean(),requestTimeoutMs:z.number().int().min(1000).max(30000),clientId:z.string().trim().max(200)}),
    secrets:z.object({clientSecret:z.string().trim().max(2048).default(''),webhookSecret:z.string().trim().max(2048).default('')})}),
};
const input=z.discriminatedUnion('provider',[schemas.WHATSAPP.extend({confirmationPassword:confirmationPasswordSchema}),schemas.IFOOD.extend({confirmationPassword:confirmationPasswordSchema})]);

export async function companySettingsRoutes(app:FastifyInstance,database:Database,env:AppEnv){
  const auth=authenticate(env,database);const manager=[auth,requireRoles('TENANT_MANAGER')];
  app.get('/company-service-settings',{preHandler:manager},request=>withTenantTransaction(database,request.auth,async client=>{
    const companies=(await client.query<{id:string;name:string}>(`SELECT DISTINCT company.id,company.name FROM companies company JOIN stores store ON store.company_id=company.id
      WHERE company.tenant_id=$1 AND store_in_scope(store.id) ORDER BY company.name`,[request.auth.tenantId])).rows;
    return {data:await Promise.all(companies.map(async company=>({company,services:await Promise.all(companyProviders.filter(item=>item==='WHATSAPP'||item==='IFOOD').map(async item=>
      safeCompanyService(await resolveCompanyService(client,env,company.id,item))))})))};
  }));
  app.put('/companies/:id/service-settings',{preHandler:[...manager,confirmManagerPassword(database)],config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async request=>{
    const companyId=id.parse(request.params).id;const value=input.parse(request.body);
    return withTenantTransaction(database,request.auth,async client=>{
      const company=(await client.query<{id:string}>(`SELECT company.id FROM companies company WHERE company.id=$1 AND company.tenant_id=$2
        AND EXISTS(SELECT 1 FROM stores store WHERE store.company_id=company.id AND store_in_scope(store.id))`,[companyId,request.auth.tenantId])).rows[0];
      if(!company)throw notFound('Empresa não encontrada no seu escopo.');
      if(value.provider==='IFOOD'&&value.publicConfig.mode==='mock'&&env.NODE_ENV==='production')throw forbidden('O modo simulado do iFood não pode ser ativado em produção.');
      const before=safeCompanyService(await resolveCompanyService(client,env,companyId,value.provider));
      const saved=await saveCompanyService(client,env,{tenantId:request.auth.tenantId,companyId,provider:value.provider,enabled:value.enabled,
        publicConfig:value.publicConfig,secrets:value.secrets,updatedBy:request.auth.userId});
      if(value.provider==='IFOOD'){
        await client.query(`UPDATE integration_connections SET events_mode=$2,
          enabled=CASE WHEN $3 THEN enabled ELSE false END,
          status=CASE WHEN $3 THEN status ELSE 'DISABLED' END,updated_at=now()
          WHERE company_id=$1 AND provider='IFOOD'`,[companyId,value.publicConfig.eventsMode,value.enabled]);
      }
      await writeAudit(client,{tenantId:request.auth.tenantId,actorUserId:request.auth.userId,action:'company.service-settings.updated',entityType:'company',entityId:companyId,
        beforeData:before,afterData:{provider:value.provider,enabled:value.enabled,publicConfig:value.publicConfig,configuredSecrets:saved.configuredSecrets}});
      return safeCompanyService(await resolveCompanyService(client,env,companyId,value.provider));
    });
  });
}
