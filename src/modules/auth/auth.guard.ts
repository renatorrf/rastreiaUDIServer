import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppEnv } from '../../config/env.js';
import { withPlatformTransaction, withRuntimeTransaction, type Database } from '../../database/pool.js';
import { forbidden, unauthorized } from '../../shared/errors.js';
import type { TenantRole } from './auth.types.js';
import { verifyAccessToken, verifyPlatformAccessToken } from './token.service.js';

function logAuthFailure(request: FastifyRequest, env: AppEnv, reason: string, context: Record<string, string> = {}) {
  request.log?.warn?.({
    auth_failure_reason: reason,
    route: request.routeOptions?.url ?? request.url,
    app_version: env.RELEASE_VERSION,
    ...(process.env['K_REVISION'] ? { cloud_run_revision: process.env['K_REVISION'] } : {}),
    ...context,
  }, 'Authentication or authorization rejected');
}

export async function assertActiveTenant(database: Database, tenantId: string): Promise<void> {
  const active = await withRuntimeTransaction(database, async (client) => {
    const result = await client.query<{ active: boolean }>(
      'SELECT rastreia.tenant_is_active($1) AS active', [tenantId],
    );
    return result.rows[0]?.active === true;
  });
  if (!active) throw unauthorized('Empresa suspensa ou indisponível.');
}

export function authenticate(env: AppEnv, database: Database) {
  return async (request: FastifyRequest): Promise<void> => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      logAuthFailure(request, env, 'missing_bearer');
      throw unauthorized();
    }

    try {
      request.auth = await verifyAccessToken(env, authorization.slice(7));
      const current = await withRuntimeTransaction(database, async (client) => {
        const result = await client.query<{ current: boolean }>(
          'SELECT rastreia.tenant_session_is_current($1, $2, $3, $4) AS current',
          [request.auth.tenantId, request.auth.userId, request.auth.role, request.auth.storeIds],
        );
        return result.rows[0]?.current === true;
      });
      if (!current) throw new Error('stale tenant session');
    } catch {
      logAuthFailure(request, env, 'tenant_token_invalid_or_stale');
      throw unauthorized('Sessão inválida ou expirada.');
    }
  };
}

export function authenticatePlatform(env: AppEnv, database: Database) {
  return async (request: FastifyRequest): Promise<void> => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      logAuthFailure(request, env, 'missing_platform_bearer');
      throw unauthorized();
    }
    const token=authorization.slice(7);
    try {
      request.platformAuth = await verifyPlatformAccessToken(env, token);
    } catch {
      try {
        const tenantClaims=await verifyAccessToken(env,token);
        logAuthFailure(request, env, 'authenticated_without_master_role', { user_id: tenantClaims.userId, tenant_id: tenantClaims.tenantId });
      } catch {
        logAuthFailure(request, env, 'platform_token_invalid');
        throw unauthorized('Sessão administrativa inválida ou expirada.');
      }
      throw forbidden('Seu perfil autenticado não possui acesso Master.');
    }
    try {
      const active = await withPlatformTransaction(database, request.platformAuth, async (client) => {
        const result = await client.query<{ active: boolean }>("SELECT status = 'ACTIVE' AS active FROM platform_admins WHERE id = $1", [request.platformAuth.userId]);
        return result.rows[0]?.active === true;
      });
      if (!active) throw new Error('inactive');
    } catch {
      logAuthFailure(request, env, 'platform_session_inactive', { user_id: request.platformAuth.userId });
      throw unauthorized('Sessão administrativa inválida ou expirada.');
    }
  };
}

export function requireRoles(...allowed: TenantRole[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!allowed.includes(request.auth.role)) throw forbidden();
  };
}
