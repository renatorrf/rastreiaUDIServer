import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { ifoodRoutes } from '../../integrations/ifood/ifood.routes.js';
import { createTokenPair } from '../auth/token.service.js';
import type { TenantRole } from '../auth/auth.types.js';
import { companySettingsRoutes } from './company-settings.routes.js';

describe('integration route security', () => {
  const id = randomUUID(), userId = randomUUID(), tenantId = randomUUID();
  const password = 'Test-only-password';
  const env = { NODE_ENV: 'development', IFOOD_MODE: 'mock', JWT_ACCESS_SECRET: 'test-only-access-secret-with-32-characters',
    JWT_ACCESS_SECRET_PREVIOUS: '', JWT_REFRESH_SECRET: 'test-only-refresh-secret-with-32-characters',
    JWT_REFRESH_SECRET_PREVIOUS: '', ACCESS_TOKEN_TTL_SECONDS: 300, REFRESH_TOKEN_TTL_SECONDS: 3600 } as AppEnv;
  let app: FastifyInstance, hash: string;
  const query = vi.fn();
  const db = { connect: async () => ({ query, release: () => {} }), query } as unknown as Database;
  const headers = async (role: TenantRole = 'TENANT_MANAGER') => ({ authorization: `Bearer ${(await createTokenPair(env, { userId, tenantId, role, storeIds: [id] })).accessToken}` });
  beforeAll(async () => { hash = await argon2.hash(password); });
  beforeEach(async () => {
    query.mockReset();query.mockImplementation(async (sql: string) => ({ rows: sql.includes('tenant_session_is_current') ? [{ current: true }] : sql.includes('SELECT u.password_hash') ? [{ password_hash: hash }] : [], rowCount: 0 }));
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => { const e = error as Error & { statusCode?: number }; reply.code(error instanceof ZodError ? 422 : e.statusCode ?? 500).send({ message: e.message }); });
    await app.register(rateLimit, { global: false });
    await companySettingsRoutes(app, db, env);await ifoodRoutes(app, db, env);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });
  it.each(['STORE_OPERATOR', 'COURIER'] as const)('blocks %s on company settings and iFood configuration reads', async role => {
    for (const url of ['/company-service-settings', '/integrations/ifood', '/integrations/ifood/health', `/integrations/ifood/${id}/events`]) {
      expect((await app.inject({ url, headers: await headers(role) })).statusCode).toBe(403);
    }
  });
  const mutations = [
    { method: 'PUT' as const, url: `/companies/${id}/service-settings` },
    { method: 'PUT' as const, url: '/integrations/ifood/connection' },
    { method: 'POST' as const, url: `/integrations/ifood/${id}/test` },
    { method: 'POST' as const, url: `/integrations/ifood/events/${id}/reprocess` },
    { method: 'POST' as const, url: `/integrations/ifood/${id}/simulate` },
  ];
  it.each(mutations)('requires the manager password before $url', async route => {
    const auth = await headers();
    expect((await app.inject({ ...route, headers: auth, payload: {} })).statusCode).toBe(422);
    expect((await app.inject({ ...route, headers: auth, payload: { confirmationPassword: 'wrong' } })).statusCode).toBe(403);
    expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && /^(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
  });
  it('allows read-only event consultation without a password', async () => {
    expect((await app.inject({ url: `/integrations/ifood/${id}/events`, headers: await headers() })).statusCode).toBe(200);
  });
  it('accepts the confirmation field for simulation, but keeps resource scope checks', async () => {
    const response = await app.inject({ method: 'POST', url: `/integrations/ifood/${id}/simulate`, headers: await headers(), payload: { scenario: 'own', confirmationPassword: password } });
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('Conexão de simulação ativa não encontrada');
  });
  it('limits repeated confirmation attempts', async () => {
    const auth = await headers();
    for (let i = 0; i < 5; i++) await app.inject({ ...mutations[0]!, headers: auth, payload: {} });
    expect((await app.inject({ ...mutations[0]!, headers: auth, payload: {} })).statusCode).toBe(429);
  });
  it.each(['WEB_PUSH', 'SMS'])('does not expose editing of %s', async provider => {
    const response = await app.inject({ ...mutations[0]!, headers: await headers(), payload: { provider, enabled: false, publicConfig: {}, secrets: {}, confirmationPassword: password } });
    expect(response.statusCode).toBe(422);
  });
});
