import argon2 from 'argon2';
import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import {
  setPlatformContext, withPlatformTransaction, withRuntimeTransaction, type Database,
} from '../../database/pool.js';
import { unauthorized } from '../../shared/errors.js';
import type { PlatformAuthContext } from '../auth/auth.types.js';
import {
  createPlatformTokenPair, hashToken, type TokenPair, verifyPlatformRefreshToken,
} from '../auth/token.service.js';

interface PlatformLoginInput {
  email: string;
  password: string;
  ip?: string;
  userAgent?: string;
}

interface PlatformAccount {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  status: 'ACTIVE' | 'BLOCKED' | 'ARCHIVED';
}

interface PlatformLoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; name: string; email: string; role: 'PLATFORM_ADMIN' };
}

async function storeSession(
  client: PoolClient,
  tokens: TokenPair,
  adminId: string,
  ip?: string,
  userAgent?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform_refresh_sessions
       (id, platform_admin_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6::inet)`,
    [tokens.sessionId, adminId, hashToken(tokens.refreshToken), tokens.refreshExpiresAt,
      userAgent ?? null, ip ?? null],
  );
}

function response(account: Pick<PlatformAccount, 'id' | 'name' | 'email'>, tokens: TokenPair, env: AppEnv): PlatformLoginResult {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    user: { id: account.id, name: account.name, email: account.email, role: 'PLATFORM_ADMIN' },
  };
}

export async function platformLogin(
  database: Database,
  env: AppEnv,
  input: PlatformLoginInput,
): Promise<PlatformLoginResult> {
  return withRuntimeTransaction(database, async (client) => {
    const result = await client.query<PlatformAccount>(
      'SELECT * FROM rastreia.resolve_platform_admin_email($1)', [input.email],
    );
    const account = result.rows[0];
    if (!account || account.status !== 'ACTIVE'
        || !(await argon2.verify(account.password_hash, input.password))) throw unauthorized();
    const tokens = await createPlatformTokenPair(env, { userId: account.id });
    await setPlatformContext(client, { userId: account.id, role: 'PLATFORM_ADMIN', sessionId: tokens.sessionId });
    await storeSession(client, tokens, account.id, input.ip, input.userAgent);
    return response(account, tokens, env);
  });
}

export async function platformRefresh(
  database: Database,
  env: AppEnv,
  refreshToken: string,
  ip?: string,
  userAgent?: string,
): Promise<PlatformLoginResult> {
  let claims: PlatformAuthContext;
  try { claims = await verifyPlatformRefreshToken(env, refreshToken); }
  catch { throw unauthorized('Sessão administrativa inválida ou expirada.'); }

  const rotated = await withPlatformTransaction(database, claims, async (client) => {
    const sessionResult = await client.query<{
      id: string; token_hash: string; revoked_at: Date | null; expires_at: Date;
    }>(
      `SELECT id, token_hash, revoked_at, expires_at
       FROM platform_refresh_sessions
       WHERE id = $1 AND platform_admin_id = $2 FOR UPDATE`,
      [claims.sessionId, claims.userId],
    );
    const session = sessionResult.rows[0];
    if (!session || session.token_hash !== hashToken(refreshToken) || session.expires_at <= new Date()) {
      throw unauthorized('Sessão administrativa inválida ou expirada.');
    }
    if (session.revoked_at) {
      await client.query(
        `UPDATE platform_refresh_sessions SET revoked_at = COALESCE(revoked_at, now())
         WHERE platform_admin_id = $1 AND revoked_at IS NULL`, [claims.userId],
      );
      return null;
    }
    const accountResult = await client.query<PlatformAccount>(
      'SELECT id, name, email, password_hash, status FROM platform_admins WHERE id = $1', [claims.userId],
    );
    const account = accountResult.rows[0];
    if (!account || account.status !== 'ACTIVE') throw unauthorized();
    const tokens = await createPlatformTokenPair(env, { userId: account.id });
    await storeSession(client, tokens, account.id, ip, userAgent);
    await client.query(
      'UPDATE platform_refresh_sessions SET revoked_at = now(), replaced_by = $2 WHERE id = $1',
      [session.id, tokens.sessionId],
    );
    return response(account, tokens, env);
  });
  if (!rotated) throw unauthorized('Reuso de sessão detectado; entre novamente.');
  return rotated;
}

export async function platformLogout(
  database: Database,
  env: AppEnv,
  refreshToken: string,
): Promise<void> {
  try {
    const claims = await verifyPlatformRefreshToken(env, refreshToken);
    await withPlatformTransaction(database, claims, async (client) => {
      await client.query(
        `UPDATE platform_refresh_sessions SET revoked_at = COALESCE(revoked_at, now())
         WHERE id = $1 AND token_hash = $2`, [claims.sessionId, hashToken(refreshToken)],
      );
    });
  } catch {
    // Logout idempotente não revela a validade do token administrativo.
  }
}
