import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withTenantTransaction, type Database } from '../../database/pool.js';
import { forbidden } from '../../shared/errors.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import { companyServiceConfigured,resolveCompanyService } from '../company-settings/company-settings.service.js';
import type { PoolClient } from 'pg';
import type { AuthContext } from '../auth/auth.types.js';

export const updateTenantSchema = z.object({
  name: z.string().trim().min(2).max(160),
  legalName: z.string().trim().max(200).nullable().optional(),
  contactPhone: z.string().trim().max(30).nullable().optional(),
  timezone: z.string().trim().min(3).max(80).default('America/Sao_Paulo'),
  updatedAt: z.iso.datetime(),
}).superRefine((input, context) => {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: input.timezone }).format();
  } catch {
    context.addIssue({ code: 'custom', path: ['timezone'], message: 'Fuso horário inválido.' });
  }
});

async function capabilities(client:PoolClient,env: AppEnv,auth:AuthContext) {
  const communicationsMock = env.NODE_ENV !== 'production' && env.COMMUNICATIONS_MOCK;
  const company=(await client.query<{company_id:string}>(`SELECT company_id FROM stores WHERE tenant_id=$1 AND store_in_scope(id) ORDER BY id LIMIT 1`,[auth.tenantId])).rows[0];
  const companyId=company?.company_id??'00000000-0000-0000-0000-000000000000';
  const [push,whatsapp,sms]=await Promise.all(['WEB_PUSH','WHATSAPP','SMS'].map(provider=>
    resolveCompanyService(client,env,companyId,provider as 'WEB_PUSH'|'WHATSAPP'|'SMS')));
  return {
    maps: Boolean(env.GEOAPIFY_API_KEY),
    realtime: Boolean(env.REDIS_URL),
    webPush: companyServiceConfigured(push!),
    whatsapp: communicationsMock || companyServiceConfigured(whatsapp!),
    sms: communicationsMock || companyServiceConfigured(sms!),
    objectStorage: env.OBJECT_STORAGE_PROVIDER === 'local'
      || Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY),
  };
}

export async function tenantRoutes(app: FastifyInstance, database: Database, env: AppEnv): Promise<void> {
  const auth = authenticate(env, database);

  app.get('/tenants/current', { preHandler: auth }, async (request) =>
    withTenantTransaction(database, request.auth, async (client) => {
      const result = await client.query(
        `SELECT id, slug, name, legal_name AS "legalName", status, timezone,
                contact_phone AS "contactPhone", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM tenants WHERE id = $1`,
        [request.auth.tenantId],
      );
      return { ...result.rows[0], capabilities: await capabilities(client,env,request.auth) };
    }),
  );

  app.patch('/tenants/current', {preHandler:[auth,requireRoles('TENANT_MANAGER')]}, async()=> {
    throw forbidden('Somente o Master pode alterar os dados compartilhados da empresa.');
  });
}
