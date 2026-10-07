import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../database/pool.js';
import type { AuthContext } from './auth.types.js';
import { verifyManagerPassword } from './confirm-manager-password.js';

describe('manager password confirmation', () => {
  const pg = new PGlite();
  const auth: AuthContext = { userId: randomUUID(), tenantId: randomUUID(), role: 'TENANT_MANAGER', storeIds: [], sessionId: randomUUID() };
  const password = 'Test-only-password';
  const database = { connect: async () => ({ query: (sql: string, params: unknown[] = []) => pg.query(sql, params), release: () => {} }) } as unknown as Database;
  beforeAll(async () => {
    await pg.exec(`CREATE ROLE rastreia_runtime; CREATE TABLE users(id uuid, password_hash text, status text);
      CREATE TABLE tenant_users(user_id uuid, tenant_id uuid, role text, status text);
      GRANT SELECT ON users, tenant_users TO rastreia_runtime;`);
    await pg.query('INSERT INTO users VALUES($1,$2,$3)', [auth.userId, await argon2.hash(password), 'ACTIVE']);
    await pg.query('INSERT INTO tenant_users VALUES($1,$2,$3,$4)', [auth.userId, auth.tenantId, auth.role, 'ACTIVE']);
  });
  afterAll(async () => { await pg.close(); });
  it('accepts the current password of an active manager', async () => {
    await expect(verifyManagerPassword(database, auth, password)).resolves.toBeUndefined();
  });
  it('rejects a wrong password without invalidating the login session', async () => {
    await expect(verifyManagerPassword(database, auth, 'wrong')).rejects.toMatchObject({ statusCode: 403, code: 'CONFIRMATION_PASSWORD_INVALID' });
  });
  it.each(['STORE_OPERATOR', 'COURIER'] as const)('rejects %s even with the right password', async role => {
    await expect(verifyManagerPassword(database, { ...auth, role }, password)).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });
  it('does not accept membership in a different tenant', async () => {
    await expect(verifyManagerPassword(database, { ...auth, tenantId: randomUUID() }, password)).rejects.toMatchObject({ statusCode: 403 });
  });
  it('rejects a disabled membership', async () => {
    await pg.query("UPDATE tenant_users SET status='INACTIVE'");
    try {
      await expect(verifyManagerPassword(database, auth, password)).rejects.toMatchObject({ statusCode: 403 });
    } finally { await pg.query("UPDATE tenant_users SET status='ACTIVE'"); }
  });
});
