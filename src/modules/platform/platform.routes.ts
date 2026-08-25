import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { unauthorized } from '../../shared/errors.js';
import { parseIdempotencyKey, type IdempotentResult } from '../../shared/idempotency.js';
import { sessionCookieOptions } from '../../shared/session-cookie.js';
import { authenticatePlatform } from '../auth/auth.guard.js';
import { platformLogin, platformLogout, platformRefresh } from './platform-auth.service.js';
import {
  changePlatformTenantStatus, createPlatformTenant, listPlatformAudit, listPlatformTenants,
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
const createSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().trim().min(2).max(160),
  legalName: z.string().trim().max(200).nullable().optional(),
  timezone: z.string().trim().min(3).max(80).default('America/Sao_Paulo'),
  contactPhone: z.string().trim().max(30).nullable().optional(),
  manager: z.object({
    name: z.string().trim().min(2).max(160), email: z.string().trim().email().toLowerCase(),
    password: z.string().min(12).max(200),
  }),
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

  app.post('/platform/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
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
  app.post('/platform/tenants', { preHandler: auth }, async (request, reply) =>
    sendIdempotent(reply, await createPlatformTenant(
      database, request.platformAuth, keyFrom(request), createSchema.parse(request.body), request.ip,
    )));
  app.patch('/platform/tenants/:id/status', { preHandler: auth }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const input = statusSchema.parse(request.body);
    return sendIdempotent(reply, await changePlatformTenantStatus(
      database, request.platformAuth, keyFrom(request), id, input.status, input.reason, request.ip,
    ));
  });
  app.get('/platform/audit', { preHandler: auth }, async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    return listPlatformAudit(database, request.platformAuth, limit);
  });
}
