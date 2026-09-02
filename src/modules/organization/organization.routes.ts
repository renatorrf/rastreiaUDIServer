import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withPlatformTransaction, type Database } from '../../database/pool.js';
import { authenticatePlatform } from '../auth/auth.guard.js';
import { parseIdempotencyKey } from '../../shared/idempotency.js';
import { conflict, notFound } from '../../shared/errors.js';
import { decryptPayload, encryptPayload } from '../../shared/encrypted-payload.js';
import { masterAudit } from '../billing/billing.service.js';
import { withPlatformIdempotency } from '../platform/platform-idempotency.js';
import { inviteManager } from '../platform/platform-units.routes.js';
import { accessScopeSchema, companySchema, contextFilterSchema, groupSchema, managerSchema, provisionOrganizationSchema } from './organization.schemas.js';
import { createCompany, grantScope, provisionOrganization } from './organization.service.js';

const idOf=(request:FastifyRequest)=>z.object({id:z.string().uuid()}).parse(request.params).id;
const reason=z.string().trim().min(5).max(500);
export async function organizationRoutes(app:FastifyInstance,database:Database,env:AppEnv) {
  const auth=authenticatePlatform(env,database);
  const mutate=async(request:FastifyRequest,reply:FastifyReply,operation:string,payload:unknown,execute:(client:PoolClient)=>Promise<unknown>)=>{
    const key=parseIdempotencyKey(request.headers['idempotency-key']);
    const result=await withPlatformTransaction(database,request.platformAuth,client=>withPlatformIdempotency(client,request.platformAuth,key,
      operation,payload,async()=>({statusCode:200,body:await execute(client)})));
    return reply.header('Idempotency-Replayed',String(result.replayed)).code(result.statusCode).send(result.body);
  };
  app.get('/platform/organization-tree',{preHandler:auth},request=>withPlatformTransaction(database,request.platformAuth,async client=>({
    groups:(await client.query('SELECT id,name,status,timezone FROM tenants ORDER BY name,id')).rows,
    companies:(await client.query('SELECT id,tenant_id,name,status FROM companies ORDER BY name,id')).rows,
    stores:(await client.query('SELECT id,tenant_id,company_id,name,status FROM stores ORDER BY name,id')).rows,
  })));
  app.get('/platform/groups',{preHandler:auth},request=>withPlatformTransaction(database,request.platformAuth,async client=>{
    const f=contextFilterSchema.parse(request.query);
    const result=await client.query(`SELECT id,name,slug,status,timezone,updated_at,count(*) OVER()::int AS total_count FROM tenants
      WHERE ($1='' OR position(lower($1) in lower(name||' '||slug))>0) AND ($2::uuid IS NULL OR id=$2)
      AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM companies WHERE companies.id=$5 AND companies.tenant_id=tenants.id))
      AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM stores WHERE stores.id=$6 AND stores.tenant_id=tenants.id))
      ORDER BY name,id LIMIT $3 OFFSET $4`,[f.search,f.tenantId??null,f.limit,f.offset,f.companyId??null,f.storeId??null]);
    return {data:result.rows,total:result.rows[0]?.total_count??0,limit:f.limit,offset:f.offset};
  }));
  app.post('/platform/groups',{preHandler:auth},(request,reply)=>{
    const input=groupSchema.parse(request.body);return mutate(request,reply,'group.create',input,async client=>{
      const row=(await client.query<{id:string}>('INSERT INTO tenants(name,slug,timezone) VALUES($1,$2,$3) RETURNING id',[input.name,input.slug,input.timezone])).rows[0]!;
      await masterAudit(client,request.platformAuth,{action:'group.created',entityType:'tenant',entityId:row.id,tenantId:row.id,after:input,reason:'Grupo criado pelo Master.'});return row;
    });
  });
  app.patch('/platform/groups/:id',{preHandler:auth},(request,reply)=>{
    const id=idOf(request);const input=groupSchema.extend({status:z.enum(['ACTIVE','SUSPENDED','ARCHIVED']),updatedAt:z.iso.datetime(),reason}).parse(request.body);
    return mutate(request,reply,'group.update',{id,...input},async client=>{
      const before=(await client.query('SELECT id,name,slug,status,timezone,updated_at FROM tenants WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!before)throw notFound();
      if(new Date(before.updated_at as Date).getTime()!==new Date(input.updatedAt).getTime())throw conflict('Grupo alterado em outra sessão. Recarregue.');
      if(before.status==='ARCHIVED'&&input.status!=='ARCHIVED')throw conflict('Grupo arquivado não pode ser reativado.');
      await client.query('UPDATE tenants SET name=$2,slug=$3,timezone=$4,status=$5 WHERE id=$1',[id,input.name,input.slug,input.timezone,input.status]);
      await masterAudit(client,request.platformAuth,{action:'group.updated',entityType:'tenant',entityId:id,tenantId:id,before,after:input,reason:input.reason});return {id};
    });
  });
  app.get('/platform/companies',{preHandler:auth},request=>withPlatformTransaction(database,request.platformAuth,async client=>{
    const f=contextFilterSchema.parse(request.query);
    const result=await client.query(`SELECT company.id,company.tenant_id,company.name,company.legal_name,company.status,company.version,
      tenant.name AS tenant_name,(company.tax_id_encrypted IS NOT NULL) AS fiscal_configured,count(*) OVER()::int AS total_count
      FROM companies company JOIN tenants tenant ON tenant.id=company.tenant_id
      WHERE ($1::uuid IS NULL OR company.tenant_id=$1) AND ($2::uuid IS NULL OR company.id=$2)
      AND ($3='' OR position(lower($3) in lower(company.name||' '||company.legal_name))>0)
      AND ($4::text IS NULL OR company.status=$4)
      AND ($7::uuid IS NULL OR EXISTS(SELECT 1 FROM stores WHERE stores.id=$7 AND stores.company_id=company.id))
      ORDER BY company.name,company.id LIMIT $5 OFFSET $6`,
      [f.tenantId??null,f.companyId??null,f.search,f.status??null,f.limit,f.offset,f.storeId??null]);
    return {data:result.rows,total:result.rows[0]?.total_count??0,limit:f.limit,offset:f.offset};
  }));
  app.get('/platform/companies/:id',{preHandler:auth},request=>withPlatformTransaction(database,request.platformAuth,async client=>{
    const row=(await client.query('SELECT * FROM companies WHERE id=$1',[idOf(request)])).rows[0];if(!row)throw notFound();
    const {tax_id_encrypted,...safe}=row;
    return {...safe,...(tax_id_encrypted?decryptPayload<{taxId:string}>(tax_id_encrypted as string,env.MESSAGE_PAYLOAD_SECRET||env.TRACKING_TOKEN_PEPPER):{taxId:''})};
  }));
  app.post('/platform/companies',{preHandler:auth},(request,reply)=>{
    const input=companySchema.extend({tenantId:z.string().uuid()}).parse(request.body);
    return mutate(request,reply,'company.create',input,client=>createCompany(client,env,request.platformAuth,input.tenantId,input));
  });
  app.patch('/platform/companies/:id',{preHandler:auth},(request,reply)=>{
    const id=idOf(request);const input=companySchema.extend({status:z.enum(['ACTIVE','INACTIVE']),version:z.number().int().positive(),reason}).parse(request.body);
    return mutate(request,reply,'company.update',{id,...input},async client=>{
      const before=(await client.query('SELECT id,tenant_id,name,legal_name,status,version FROM companies WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!before)throw notFound();
      if(before.version!==input.version)throw conflict('Empresa alterada em outra sessão. Recarregue.');
      await client.query('UPDATE companies SET name=$2,legal_name=$3,tax_id_encrypted=$4,status=$5,version=version+1 WHERE id=$1',
        [id,input.name,input.legalName,encryptPayload({taxId:input.taxId},env.MESSAGE_PAYLOAD_SECRET||env.TRACKING_TOKEN_PEPPER),input.status]);
      await masterAudit(client,request.platformAuth,{action:'company.updated',entityType:'company',entityId:id,tenantId:before.tenant_id,
        before,after:{name:input.name,legalName:input.legalName,status:input.status,taxIdMasked:`***${input.taxId.slice(-4)}`},reason:input.reason});return {id};
    });
  });
  app.post('/platform/organizations/provision',{preHandler:auth},(request,reply)=>{
    const input=provisionOrganizationSchema.parse(request.body);
    return mutate(request,reply,'organization.provision',input,client=>provisionOrganization(client,env,request.platformAuth,input));
  });
  app.get('/platform/access-scopes',{preHandler:auth},request=>withPlatformTransaction(database,request.platformAuth,async client=>{
    const f=contextFilterSchema.parse(request.query);
    const rows=await client.query(`SELECT scope.*,account.name AS user_name,account.email,tenant.name AS tenant_name,
      company.name AS company_name,store.name AS store_name,count(*) OVER()::int AS total_count
      FROM user_access_scopes scope JOIN users account ON account.id=scope.user_id JOIN tenants tenant ON tenant.id=scope.tenant_id
      LEFT JOIN companies company ON company.id=scope.company_id LEFT JOIN stores store ON store.id=scope.store_id
      WHERE ($1::uuid IS NULL OR scope.tenant_id=$1)
      AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM companies selected WHERE selected.id=$2 AND selected.tenant_id=scope.tenant_id
        AND (scope.company_id=selected.id OR scope.scope_level='TENANT')))
      AND ($3='' OR position(lower($3) in lower(account.name||' '||account.email))>0)
      AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM stores selected WHERE selected.id=$6 AND selected.tenant_id=scope.tenant_id
        AND (scope.scope_level='TENANT' OR (scope.scope_level='COMPANY' AND scope.company_id=selected.company_id) OR scope.store_id=selected.id)))
      ORDER BY scope.created_at DESC,scope.id LIMIT $4 OFFSET $5`,[f.tenantId??null,f.companyId??null,f.search,f.limit,f.offset,f.storeId??null]);
    return {data:rows.rows,total:rows.rows[0]?.total_count??0,limit:f.limit,offset:f.offset};
  }));
  app.post('/platform/access-scopes',{preHandler:auth},(request,reply)=>{
    const input=z.object({manager:managerSchema,scope:accessScopeSchema,reason}).parse(request.body);
    return mutate(request,reply,'scope.grant',input,async client=>{
      const manager=await inviteManager(client,env,request.platformAuth,input.scope.tenantId,input.scope.storeId,input.manager,false);
      return {...await grantScope(client,request.platformAuth,manager.id as string,input.scope,input.reason),manager};
    });
  });
  app.post('/platform/access-scopes/:id/revoke',{preHandler:auth},(request,reply)=>{
    const id=idOf(request);const input=z.object({reason}).parse(request.body);
    return mutate(request,reply,'scope.revoke',{id,...input},async client=>{
      const before=(await client.query('SELECT * FROM user_access_scopes WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!before)throw notFound();
      await client.query("UPDATE user_access_scopes SET status='REVOKED' WHERE id=$1",[id]);
      await masterAudit(client,request.platformAuth,{action:'scope.revoked',entityType:'access_scope',entityId:id,tenantId:before.tenant_id,
        before,after:{status:'REVOKED'},reason:input.reason});return {id};
    });
  });
}
