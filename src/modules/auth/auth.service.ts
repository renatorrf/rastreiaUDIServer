import argon2 from 'argon2';
import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import { setTenantContext, withRuntimeTransaction, withTenantTransaction } from '../../database/pool.js';
import type { Database } from '../../database/pool.js';
import { unauthorized } from '../../shared/errors.js';
import type { AuthContext, TenantRole } from './auth.types.js';
import {
  createTokenPair,
  hashToken,
  type TokenPair,
  verifyRefreshToken,
} from './token.service.js';

const anonymousUserId = '00000000-0000-0000-0000-000000000000';

interface LoginInput {
  tenantSlug: string;
  email: string;
  password: string;
  ip?: string;
  userAgent?: string;
}

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; name: string; email: string; role: TenantRole; storeIds: string[] };
  tenant: { id: string; slug: string; name: string; timezone: string };
}

interface LoginRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: TenantRole;
}

async function storeSession(
  client: PoolClient,
  tokens: TokenPair,
  auth: Omit<AuthContext, 'sessionId'>,
  ip?: string,
  userAgent?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO refresh_sessions
       (id, tenant_id, user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7::inet)`,
    [
      tokens.sessionId,
      auth.tenantId,
      auth.userId,
      hashToken(tokens.refreshToken),
      tokens.refreshExpiresAt,
      userAgent ?? null,
      ip ?? null,
    ],
  );
}

export async function login(database: Database, env: AppEnv, input: LoginInput): Promise<LoginResult> {
  return withRuntimeTransaction(database, async (client) => {
    const tenantResult = await client.query<{
      id: string;
      slug: string;
      name: string;
      status: string;
      timezone: string;
    }>('SELECT * FROM rastreia.resolve_tenant_slug($1)', [input.tenantSlug]);
    const tenant = tenantResult.rows[0];
    if (!tenant || tenant.status !== 'ACTIVE') throw unauthorized();

    await setTenantContext(client, { tenantId: tenant.id, userId: anonymousUserId });
    const accountResult = await client.query<LoginRow>(
      `SELECT u.id, u.name, u.email,
              COALESCE(membership.password_hash, u.password_hash) AS password_hash,
              membership.role
       FROM users u
       JOIN tenant_users membership ON membership.user_id = u.id
       WHERE membership.tenant_id = $1
         AND membership.status = 'ACTIVE'
         AND u.status = 'ACTIVE'
         AND u.email = $2::citext
       LIMIT 1`,
      [tenant.id, input.email],
    );
    const account = accountResult.rows[0];
    if (!account || !(await argon2.verify(account.password_hash, input.password))) throw unauthorized();

    await setTenantContext(client, { tenantId: tenant.id, userId: account.id });
    const storeResult = await client.query<{ store_id: string }>(
      `SELECT access.store_id
       FROM user_store_access access
       JOIN tenant_users membership ON membership.id = access.tenant_user_id
       WHERE membership.tenant_id = $1 AND membership.user_id = $2`,
      [tenant.id, account.id],
    );
    const storeIds = storeResult.rows.map((row) => row.store_id);
    const auth = { userId: account.id, tenantId: tenant.id, role: account.role, storeIds };
    const tokens = await createTokenPair(env, auth);
    await storeSession(client, tokens, auth, input.ip, input.userAgent);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      user: { id: account.id, name: account.name, email: account.email, role: account.role, storeIds },
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, timezone: tenant.timezone },
    };
  });
}

export async function refresh(
  database: Database,
  env: AppEnv,
  refreshToken: string,
  ip?: string,
  userAgent?: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; name: string; email: string; role: TenantRole; storeIds: string[] };
  tenant: { id: string; slug: string; name: string; timezone: string };
}> {
  let claims: AuthContext;
  try {
    claims = await verifyRefreshToken(env, refreshToken);
  } catch {
    throw unauthorized('Sessão inválida ou expirada.');
  }

  const rotated = await withTenantTransaction(database, claims, async (client) => {
    const sessionResult = await client.query<{
      id: string;
      token_hash: string;
      revoked_at: Date | null;
      expires_at: Date;
    }>(
      `SELECT id, token_hash, revoked_at, expires_at
       FROM refresh_sessions
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3
       FOR UPDATE`,
      [claims.sessionId, claims.tenantId, claims.userId],
    );
    const session = sessionResult.rows[0];
    const incomingHash = hashToken(refreshToken);
    if (!session || session.token_hash !== incomingHash || session.expires_at <= new Date()) {
      throw unauthorized('Sessão inválida ou expirada.');
    }
    if (session.revoked_at) {
      await client.query(
        `UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, now())
         WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [claims.tenantId, claims.userId],
      );
      return null;
    }

    const membershipResult = await client.query<{
      role: TenantRole;
      user_name: string;
      email: string;
      tenant_slug: string;
      tenant_name: string;
      timezone: string;
    }>(
      `SELECT membership.role, u.name AS user_name, u.email,
              t.slug AS tenant_slug, t.name AS tenant_name, t.timezone
       FROM tenant_users membership
       JOIN users u ON u.id = membership.user_id
       JOIN tenants t ON t.id = membership.tenant_id
       WHERE membership.tenant_id = $1 AND membership.user_id = $2
         AND membership.status = 'ACTIVE' AND u.status = 'ACTIVE' AND t.status = 'ACTIVE'`,
      [claims.tenantId, claims.userId],
    );
    const membership = membershipResult.rows[0];
    if (!membership) throw unauthorized();

    const stores = await client.query<{ store_id: string }>(
      `SELECT access.store_id FROM user_store_access access
       JOIN tenant_users membership ON membership.id = access.tenant_user_id
       WHERE membership.tenant_id = $1 AND membership.user_id = $2`,
      [claims.tenantId, claims.userId],
    );
    const auth = {
      userId: claims.userId,
      tenantId: claims.tenantId,
      role: membership.role,
      storeIds: stores.rows.map((row) => row.store_id),
    };
    const tokens = await createTokenPair(env, auth);
    await storeSession(client, tokens, auth, ip, userAgent);
    await client.query(
      'UPDATE refresh_sessions SET revoked_at = now(), replaced_by = $2 WHERE id = $1',
      [session.id, tokens.sessionId],
    );

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      user: {
        id: claims.userId,
        name: membership.user_name,
        email: membership.email,
        role: membership.role,
        storeIds: auth.storeIds,
      },
      tenant: {
        id: claims.tenantId,
        slug: membership.tenant_slug,
        name: membership.tenant_name,
        timezone: membership.timezone,
      },
    };
  });
  if (!rotated) throw unauthorized('Reuso de sessão detectado; entre novamente.');
  return rotated;
}

export async function logout(database: Database, env: AppEnv, refreshToken: string): Promise<void> {
  try {
    const claims = await verifyRefreshToken(env, refreshToken);
    await withTenantTransaction(database, claims, async (client) => {
      await client.query(
        `UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, now())
         WHERE id = $1 AND token_hash = $2`,
        [claims.sessionId, hashToken(refreshToken)],
      );
    });
  } catch {
    // Logout is intentionally idempotent and does not reveal token validity.
  }
}
