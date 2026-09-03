import { createHmac, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAppEnv } from '../src/config/env.js';
import type { Database } from '../src/database/pool.js';
import { createMasterLoginGrant, verifyMasterLoginGrant } from '../src/security/master-access.js';
import { platformRoutes } from '../src/modules/platform/platform.routes.js';
import { platformLogin } from '../src/modules/platform/platform-auth.service.js';
import { createPlatformTokenPair, verifyPlatformAccessToken } from '../src/modules/auth/token.service.js';
import { AppError, unauthorized } from '../src/shared/errors.js';

vi.mock('../src/modules/platform/platform-auth.service.js', () => ({
  platformLogin: vi.fn(), platformRefresh: vi.fn(), platformLogout: vi.fn(),
}));
const source = {
  DATABASE_URL: 'postgresql://example:example@localhost:5432/example',
  JWT_ACCESS_SECRET: 'a'.repeat(43), JWT_REFRESH_SECRET: 'b'.repeat(43),
  TRACKING_TOKEN_PEPPER: 'c'.repeat(43), MASTER_ACCESS_TOKEN: 'd'.repeat(43),
};
const env = parseAppEnv(source);
const apps: FastifyInstance[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.resetAllMocks();
  await Promise.all(apps.splice(0).map(app => app.close()));
});
async function api(overrides = {}) {
  const app = Fastify(); apps.push(app);
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code } });
    return reply.send(error);
  });
  const database = { query: vi.fn(), connect: vi.fn() } as unknown as Database;
  await platformRoutes(app, database, { ...env, ...overrides });
  return app;
}
const credentials = { email: 'master@example.test', password: 'Synthetic-password!' };

describe('master login permission', () => {
  it('requires a configured secret of 32 to 256 characters', async () => {
    expect(() => parseAppEnv({ ...source, MASTER_ACCESS_TOKEN: 'short' })).toThrow();
    expect(() => parseAppEnv({ ...source, MASTER_ACCESS_TOKEN: 'x'.repeat(257) })).toThrow();
    const empty = parseAppEnv({ ...source, MASTER_ACCESS_TOKEN: '' });
    await expect(createMasterLoginGrant(empty, source.MASTER_ACCESS_TOKEN)).rejects.toMatchObject({ statusCode: 503 });
    await expect(verifyMasterLoginGrant(empty, 'anything')).rejects.toMatchObject({ statusCode: 503 });
  });
  it('issues a five-minute permission only for the matching fixed secret', async () => {
    const permission = await createMasterLoginGrant(env, env.MASTER_ACCESS_TOKEN);
    expect(permission.expiresIn).toBe(300);
    await expect(verifyMasterLoginGrant(env, permission.grant)).resolves.toBeUndefined();
    for (const wrong of ['', 'wrong', 'e'.repeat(43)]) {
      await expect(createMasterLoginGrant(env, wrong)).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(JSON.stringify(permission)).not.toContain(env.MASTER_ACCESS_TOKEN);
  });
  it('rejects missing, malformed, tampered and expired permissions', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const { grant } = await createMasterLoginGrant(env, env.MASTER_ACCESS_TOKEN);
    for (const invalid of [undefined, [], 'x'.repeat(2049), 'not-a-jwt', grant + 'tampered']) {
      await expect(verifyMasterLoginGrant(env, invalid)).rejects.toMatchObject({ statusCode: 403 });
    }
    vi.setSystemTime(new Date('2026-09-01T00:05:01Z'));
    await expect(verifyMasterLoginGrant(env, grant)).rejects.toMatchObject({ statusCode: 403 });
  });
  it('invalidates outstanding permissions when the fixed secret is rotated', async () => {
    const { grant } = await createMasterLoginGrant(env, env.MASTER_ACCESS_TOKEN);
    await expect(verifyMasterLoginGrant({ ...env, MASTER_ACCESS_TOKEN: 'e'.repeat(43) }, grant))
      .rejects.toMatchObject({ statusCode: 403 });
  });
  it('separates login permission from administrative session tokens', async () => {
    const { grant } = await createMasterLoginGrant(env, env.MASTER_ACCESS_TOKEN);
    await expect(verifyPlatformAccessToken(env, grant)).rejects.toThrow();
    const session = await createPlatformTokenPair(env, { userId: randomUUID() });
    await expect(verifyMasterLoginGrant(env, session.accessToken)).rejects.toMatchObject({ statusCode: 403 });
  });
  it('requires the right audience and purpose even with a valid signature', async () => {
    const key = createHmac('sha256', env.JWT_ACCESS_SECRET).update('rastreia-master-login-gate\0' + env.MASTER_ACCESS_TOKEN).digest();
    for (const [audience, purpose] of [['wrong', 'master-login'], ['rastreia-master-login-gate', 'wrong']]) {
      const grant = await new SignJWT({ purpose }).setProtectedHeader({ alg: 'HS256' })
        .setIssuer('rastreia-backend').setAudience(audience!).setSubject('master-entry')
        .setJti(randomUUID()).setIssuedAt().setExpirationTime('300s').sign(key);
      await expect(verifyMasterLoginGrant(env, grant)).rejects.toMatchObject({ statusCode: 403 });
    }
  });
});

describe('master entry API enforcement', () => {
  it('rejects direct login before the credential service can run', async () => {
    const app = await api();
    for (const headers of [{}, { 'x-master-login-grant': 'forged' }]) {
      const response = await app.inject({ method: 'POST', url: '/platform/auth/login', payload: credentials, headers });
      expect(response.statusCode).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(platformLogin).not.toHaveBeenCalled();
  });
  it('requires password authentication after entry verification', async () => {
    const app = await api();
    const unlocked = await app.inject({ method: 'POST', url: '/platform/auth/access', payload: { token: env.MASTER_ACCESS_TOKEN } });
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.headers['cache-control']).toBe('no-store');
    expect(unlocked.headers['set-cookie']).toBeUndefined();
    const headers = { 'x-master-login-grant': unlocked.json().grant };
    vi.mocked(platformLogin).mockRejectedValueOnce(unauthorized());
    const denied = await app.inject({ method: 'POST', url: '/platform/auth/login', payload: credentials, headers });
    expect(denied.statusCode).toBe(401);
    vi.mocked(platformLogin).mockResolvedValueOnce({
      accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresIn: 900,
      user: { id: randomUUID(), name: 'Master', email: credentials.email, role: 'PLATFORM_ADMIN' },
    });
    const accepted = await app.inject({ method: 'POST', url: '/platform/auth/login', payload: credentials, headers });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().accessToken).toBe('synthetic-access');
    expect(accepted.headers['set-cookie']).toContain('rastreia_platform_refresh=');
    expect(platformLogin).toHaveBeenCalledTimes(2);
  });
  it('fails closed when the deployment has no master secret', async () => {
    const app = await api({ MASTER_ACCESS_TOKEN: '' });
    const response = await app.inject({ method: 'POST', url: '/platform/auth/access', payload: { token: 'test' } });
    expect(response.statusCode).toBe(503);
    const login = await app.inject({ method: 'POST', url: '/platform/auth/login', payload: credentials });
    expect(login.statusCode).toBe(503);
    expect(platformLogin).not.toHaveBeenCalled();
  });
  it.each(['/platform/auth/access', '/platform/auth/login'])('throttles repeated attempts to %s', async url => {
    const app = await api();
    for (let count = 0; count < 5; count++) {
      const response = await app.inject({ method: 'POST', url, payload: { ...credentials, token: 'wrong' } });
      expect(response.statusCode).toBe(403);
    }
    const blocked = await app.inject({ method: 'POST', url, payload: { ...credentials, token: 'wrong' } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(platformLogin).not.toHaveBeenCalled();
  });
});
