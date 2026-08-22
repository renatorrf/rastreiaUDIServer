import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppEnv } from '../../config/env.js';
import { withPlatformTransaction, withRuntimeTransaction, type Database } from '../../database/pool.js';
import { forbidden, unauthorized } from '../../shared/errors.js';
import type { TenantRole } from './auth.types.js';
import { verifyAccessToken, verifyPlatformAccessToken } from './token.service.js';

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
    if (!authorization?.startsWith('Bearer ')) throw unauthorized();

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
      throw unauthorized('Sessão inválida ou expirada.');
    }
  };
}

export function authenticatePlatform(env: AppEnv, database: Database) {
  return async (request: FastifyRequest): Promise<void> => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw unauthorized();
    try {
      request.platformAuth = await verifyPlatformAccessToken(env, authorization.slice(7));
      const active = await withPlatformTransaction(database, request.platformAuth, async (client) => {
        const result = await client.query<{ active: boolean }>(
          "SELECT status = 'ACTIVE' AS active FROM platform_admins WHERE id = $1", [request.platformAuth.userId],
        );
        return result.rows[0]?.active === true;
      });
      if (!active) throw new Error('inactive');
    } catch {
      throw unauthorized('Sessão administrativa inválida ou expirada.');
    }
  };
}

export function requireRoles(...allowed: TenantRole[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!allowed.includes(request.auth.role)) throw forbidden();
  };
}
