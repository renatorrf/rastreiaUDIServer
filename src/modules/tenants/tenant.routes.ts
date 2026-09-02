import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withTenantTransaction, type Database } from '../../database/pool.js';
import { forbidden } from '../../shared/errors.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';

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

function capabilities(env: AppEnv) {
  const communicationsMock = env.NODE_ENV !== 'production' && env.COMMUNICATIONS_MOCK;
  return {
    maps: Boolean(env.GEOAPIFY_API_KEY),
    realtime: Boolean(env.REDIS_URL),
    webPush: Boolean(env.PUSH_VAPID_SUBJECT && env.PUSH_VAPID_PUBLIC_KEY && env.PUSH_VAPID_PRIVATE_KEY),
    whatsapp: communicationsMock || Boolean(env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN
      && env.WHATSAPP_TRACKING_TEMPLATE),
    sms: communicationsMock || (env.SMS_PROVIDER === 'webhook' && Boolean(env.SMS_API_URL && env.SMS_API_KEY)),
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
      return { ...result.rows[0], capabilities: capabilities(env) };
    }),
  );

  app.patch('/tenants/current', {preHandler:[auth,requireRoles('TENANT_MANAGER')]}, async()=> {
    throw forbidden('Somente o Master pode alterar os dados compartilhados da empresa.');
  });
}
