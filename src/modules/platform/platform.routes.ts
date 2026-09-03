import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withPlatformTransaction, type Database } from '../../database/pool.js';
import { conflict, notFound, unauthorized } from '../../shared/errors.js';
import { updateTenantSchema } from '../tenants/tenant.routes.js';
import { withPlatformIdempotency } from './platform-idempotency.js';
import { masterAudit } from '../billing/billing.service.js';
import { parseIdempotencyKey, type IdempotentResult } from '../../shared/idempotency.js';
import { sessionCookieOptions } from '../../shared/session-cookie.js';
import { authenticatePlatform } from '../auth/auth.guard.js';
import { platformLogin, platformLogout, platformRefresh } from './platform-auth.service.js';
import { createMasterLoginGrant, verifyMasterLoginGrant } from '../../security/master-access.js';
import {
  changePlatformTenantStatus, listPlatformAudit, listPlatformTenants,
} from './platform.service.js';

const loginSchema = z.object({
  email: z.string().trim().email().toLowerCase(), password: z.string().min(8).max(200),
});
const tenantStatus = z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']);
const listSchema = z.object({
  search: z.string().trim().max(120).optional(), status: tenantStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const statusSchema = z.object({ status: tenantStatus, reason: z.string().trim().min(5).max(500) });
const idSchema = z.object({ id: z.string().uuid() });

function keyFrom(request: FastifyRequest) { return parseIdempotencyKey(request.headers['idempotency-key']); }
function sendIdempotent<T>(reply: FastifyReply, result: IdempotentResult<T>) {
  reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false');
  return reply.status(result.statusCode).send(result.body);
}

export async function platformRoutes(app: FastifyInstance, database: Database, env: AppEnv): Promise<void> {
  const auth = authenticatePlatform(env, database);

  app.post('/platform/auth/access', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { token } = z.object({ token: z.string().min(1).max(256) }).parse(request.body);
    return createMasterLoginGrant(env, token);
  });
  app.post('/platform/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      await verifyMasterLoginGrant(env, request.headers['x-master-login-grant']);
    },
  }, async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const result = await platformLogin(database, env, { ...input, ip: request.ip,
      ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}) });
    reply.setCookie('rastreia_platform_refresh', result.refreshToken,
      sessionCookieOptions(env, '/platform/auth', 'strict'));
    return { accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user };
  });
  app.post('/platform/auth/refresh', async (request, reply) => {
    const token = request.cookies['rastreia_platform_refresh'];
    if (!token) throw unauthorized('Sessão administrativa ausente.');
    const result = await platformRefresh(database, env, token, request.ip, request.headers['user-agent']);
    reply.setCookie('rastreia_platform_refresh', result.refreshToken,
      sessionCookieOptions(env, '/platform/auth', 'strict'));
    return { accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user };
  });
  app.post('/platform/auth/logout', async (request, reply) => {
    const token = request.cookies['rastreia_platform_refresh'];
    if (token) await platformLogout(database, env, token);
    reply.clearCookie('rastreia_platform_refresh', sessionCookieOptions(env, '/platform/auth', 'strict'));
    return reply.status(204).send();
  });
  app.get('/platform/tenants', { preHandler: auth }, async (request) =>
    listPlatformTenants(database, request.platformAuth, listSchema.parse(request.query)));
  app.patch('/platform/tenants/:id',{preHandler:auth},async(request,reply)=>{
    const {id}=idSchema.parse(request.params);
    const body=z.object({tenant:updateTenantSchema,reason:z.string().trim().min(5).max(500)}).parse(request.body);
    const result=await withPlatformTransaction(database,request.platformAuth,client=>withPlatformIdempotency(client,request.platformAuth,
      keyFrom(request),'tenant.details',{id,...body},async()=>{
        const before=(await client.query<{updated_at:Date;status:string}>('SELECT * FROM tenants WHERE id=$1 FOR UPDATE',[id])).rows[0];
        if(!before)throw notFound();if(before.status==='ARCHIVED')throw conflict('Empresa arquivada.');
        if(before.updated_at.getTime()!==new Date(body.tenant.updatedAt).getTime())throw conflict('Dados alterados em outra sessão. Recarregue.');
        const input=body.tenant;
        await client.query('UPDATE tenants SET name=$2,legal_name=$3,contact_phone=$4,timezone=$5 WHERE id=$1',
          [id,input.name,input.legalName??null,input.contactPhone??null,input.timezone]);
        await masterAudit(client,request.platformAuth,{action:'tenant.details_updated',entityType:'tenant',entityId:id,tenantId:id,
          before,after:input,reason:body.reason});return {statusCode:200,body:{id}};
      }));return sendIdempotent(reply,result);
  });
  app.patch('/platform/tenants/:id/status', { preHandler: auth }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const input = statusSchema.parse(request.body);
    return sendIdempotent(reply, await changePlatformTenantStatus(
      database, request.platformAuth, keyFrom(request), id, input.status, input.reason, request.ip,
    ));
  });
  app.get('/platform/audit', { preHandler: auth }, async (request) => {
    const filters = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30),
      tenantId:z.string().uuid().optional(),companyId:z.string().uuid().optional(),storeId:z.string().uuid().optional() }).parse(request.query);
    return listPlatformAudit(database, request.platformAuth, filters.limit, filters);
  });
}
