import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { PlatformAuthContext } from '../auth/auth.types.js';
import { encryptPayload } from '../../shared/encrypted-payload.js';
import { conflict, notFound } from '../../shared/errors.js';
import { masterAudit, saveBillingProfile } from '../billing/billing.service.js';
import { inviteManager } from '../platform/platform-units.routes.js';
import { accessScopeSchema, companySchema, provisionOrganizationSchema } from './organization.schemas.js';

export async function createCompany(client:PoolClient,env:AppEnv,auth:PlatformAuthContext,tenantId:string,input:z.infer<typeof companySchema>) {
  if(!(await client.query("SELECT id FROM tenants WHERE id=$1 AND status='ACTIVE' FOR SHARE",[tenantId])).rowCount)throw conflict('Grupo inativo ou inexistente.');
  const row=(await client.query<{id:string}>(`INSERT INTO companies(tenant_id,name,legal_name,tax_id_encrypted) VALUES($1,$2,$3,$4) RETURNING id`,
    [tenantId,input.name,input.legalName,encryptPayload({taxId:input.taxId},env.MESSAGE_PAYLOAD_SECRET||env.TRACKING_TOKEN_PEPPER)])).rows[0]!;
  await masterAudit(client,auth,{action:'company.created',entityType:'company',entityId:row.id,tenantId,
    after:{name:input.name,legalName:input.legalName,taxIdMasked:`***${input.taxId.slice(-4)}`},reason:'Empresa jurídica cadastrada pelo Master.'});
  return row;
}

export async function grantScope(client:PoolClient,auth:PlatformAuthContext,userId:string,input:z.infer<typeof accessScopeSchema>,reason:string) {
  if(!(await client.query("SELECT id FROM tenants WHERE id=$1 AND status='ACTIVE'",[input.tenantId])).rowCount)throw notFound('Grupo não disponível.');
  if(input.companyId&&!(await client.query("SELECT id FROM companies WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'",[input.companyId,input.tenantId])).rowCount)
    throw conflict('Empresa não pertence ao grupo selecionado ou está inativa.');
  if(input.storeId&&!(await client.query("SELECT id FROM stores WHERE id=$1 AND company_id=$2 AND tenant_id=$3 AND status='ACTIVE'",[input.storeId,input.companyId,input.tenantId])).rowCount)
    throw conflict('Unidade não pertence à empresa selecionada ou está inativa.');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${userId}:${input.tenantId}:scopes`]);
  const existing=(await client.query<{id:string}>(`SELECT id FROM user_access_scopes WHERE user_id=$1 AND tenant_id=$2 AND scope_level=$3
    AND company_id IS NOT DISTINCT FROM $4::uuid AND store_id IS NOT DISTINCT FROM $5::uuid AND status='ACTIVE' FOR UPDATE`,
    [userId,input.tenantId,input.level,input.companyId??null,input.storeId??null])).rows[0];
  const scope=existing??(await client.query<{id:string}>(`INSERT INTO user_access_scopes(tenant_id,user_id,scope_level,company_id,store_id,valid_until,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[input.tenantId,userId,input.level,input.companyId??null,input.storeId??null,input.validUntil??null,auth.userId])).rows[0]!;
  if(existing)await client.query('UPDATE user_access_scopes SET valid_from=now(),valid_until=$2 WHERE id=$1',[scope.id,input.validUntil??null]);
  await masterAudit(client,auth,{action:'scope.granted',entityType:'access_scope',entityId:scope.id,tenantId:input.tenantId,after:{userId,...input},reason});
  return scope;
}

export async function provisionOrganization(client:PoolClient,env:AppEnv,auth:PlatformAuthContext,input:z.infer<typeof provisionOrganizationSchema>) {
  const tenant=(await client.query<{id:string}>('INSERT INTO tenants(name,slug,timezone) VALUES($1,$2,$3) RETURNING id',
    [input.group.name,input.group.slug,input.group.timezone])).rows[0]!;
  const targets=new Map<string,{companyId:string;storeId?:string}>();
  for(const draft of input.companies) {
    const company=await createCompany(client,env,auth,tenant.id,draft.company);
    targets.set(draft.key,{companyId:company.id});
    for(const unit of draft.units) {
      const s=unit.store;
      const store=(await client.query<{id:string}>(`INSERT INTO stores(tenant_id,company_id,name,address_line,address_number,complement,neighborhood,
        city,state,postal_code,latitude,longitude,contact_phone,plan_code,address_confidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [tenant.id,company.id,s.name,s.addressLine,s.addressNumber??null,s.complement??null,s.neighborhood??null,s.city,s.state,
          s.postalCode??null,s.latitude,s.longitude,s.contactPhone??null,unit.billing.planCode,s.addressConfidence??null])).rows[0]!;
      await saveBillingProfile(client,env,auth,store.id,unit.billing,'Faturamento definido no provisionamento do grupo.');
      targets.set(unit.key,{companyId:company.id,storeId:store.id});
    }
  }
  const manager=await inviteManager(client,env,auth,tenant.id,undefined,input.manager,false);
  const keys=input.scope.level==='TENANT'?['']:Array.from(new Set(input.scope.targetKeys));
  for(const key of keys)await grantScope(client,auth,manager.id as string,accessScopeSchema.parse({level:input.scope.level,tenantId:tenant.id,...(targets.get(key)??{})}),
    'Escopo inicial explicitamente escolhido pelo Master.');
  await masterAudit(client,auth,{action:'organization.provisioned',entityType:'tenant',entityId:tenant.id,tenantId:tenant.id,
    after:{companies:input.companies.length,units:input.companies.reduce((sum,c)=>sum+c.units.length,0),managerId:manager.id,scope:input.scope.level},
    reason:'Grupo, empresas, unidades, gestor e convite criados em uma transação.'});
  return {id:tenant.id,manager,targets:Object.fromEntries(targets)};
}
