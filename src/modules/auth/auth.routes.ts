import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { setTenantContext, withRuntimeTransaction, type Database } from '../../database/pool.js';
import { unauthorized } from '../../shared/errors.js';
import { sessionCookieOptions } from '../../shared/session-cookie.js';
import { login, logout, refresh } from './auth.service.js';

const loginSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(63).toLowerCase(),
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(8).max(200),
});

const passwordResetRequestSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(63).toLowerCase(),
  email: z.string().trim().email().toLowerCase(),
});

const anonymousUserId = '00000000-0000-0000-0000-000000000000';

export async function authRoutes(app: FastifyInstance, database: Database, env: AppEnv): Promise<void> {
  app.post('/auth/password-reset-requests', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const input = passwordResetRequestSchema.parse(request.body);
    await withRuntimeTransaction(database, async (client) => {
      const tenantResult = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM rastreia.resolve_tenant_slug($1)', [input.tenantSlug],
      );
      const tenant = tenantResult.rows[0];
      if (!tenant || tenant.status !== 'ACTIVE') return;

      await setTenantContext(client, { tenantId: tenant.id, userId: anonymousUserId });
      const accountResult = await client.query<{ user_id: string }>(
        `SELECT membership.user_id
         FROM tenant_users membership
         JOIN users account ON account.id = membership.user_id
         WHERE membership.tenant_id = $1
           AND membership.status = 'ACTIVE'
           AND account.status = 'ACTIVE'
           AND account.email = $2::citext
         LIMIT 1`,
        [tenant.id, input.email],
      );
      const account = accountResult.rows[0];
      if (!account) return;

      await client.query(
        `INSERT INTO password_reset_requests (tenant_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (tenant_id, user_id) WHERE status = 'PENDING'
         DO UPDATE SET requested_at = now()`,
        [tenant.id, account.user_id],
      );
    });
    return reply.status(202).send({
      message: 'Se os dados estiverem corretos, o gestor da empresa receberá a solicitação.',
    });
  });

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const userAgent = request.headers['user-agent'];
    const result = await login(database, env, {
      ...input,
      ip: request.ip,
      ...(userAgent === undefined ? {} : { userAgent }),
    });
    reply.setCookie('rastreia_refresh', result.refreshToken, sessionCookieOptions(env, '/auth'));
    return reply.send({
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
      tenant: result.tenant,
    });
  });

  app.post('/auth/refresh', async (request, reply) => {
    const token = request.cookies['rastreia_refresh'];
    if (!token) throw unauthorized('Sessão ausente.');
    const result = await refresh(database, env, token, request.ip, request.headers['user-agent']);
    reply.setCookie('rastreia_refresh', result.refreshToken, sessionCookieOptions(env, '/auth'));
    return reply.send({
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
      tenant: result.tenant,
    });
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies['rastreia_refresh'];
    if (token) await logout(database, env, token);
    reply.clearCookie('rastreia_refresh', sessionCookieOptions(env, '/auth'));
    return reply.status(204).send();
  });
}
