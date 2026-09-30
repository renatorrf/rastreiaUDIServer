import { afterEach, describe, expect, it } from 'vitest';
import { getEnv, resetEnvForTests } from '../src/config/env.js';
import { decodeJwt } from 'jose';
import { randomUUID } from 'node:crypto';
import { createPlatformTokenPair, createTokenPair } from '../src/modules/auth/token.service.js';
import { sessionCookieOptions } from '../src/shared/session-cookie.js';

afterEach(() => resetEnvForTests());

describe('hardening da configuração', () => {
  it('defaults operational and master access/refresh tokens and cookies to twelve hours', async () => {
    const env = getEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test',
      JWT_ACCESS_SECRET: 'test-only-access-secret-with-32-characters',
      JWT_REFRESH_SECRET: 'test-only-refresh-secret-with-32-characters',
      TRACKING_TOKEN_PEPPER: 'test-only-tracking-pepper-with-32-characters' });
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(43200);
    expect(env.REFRESH_TOKEN_TTL_SECONDS).toBe(43200);
    const userId = randomUUID();
    const pairs = [await createTokenPair(env, { userId, tenantId: randomUUID(), role: 'COURIER', storeIds: [] }),
      await createPlatformTokenPair(env, { userId })];
    for (const pair of pairs) for (const token of [pair.accessToken, pair.refreshToken]) {
      const claims = decodeJwt(token); expect(claims.exp! - claims.iat!).toBe(43200);
    }
    expect(sessionCookieOptions(env, '/auth').maxAge).toBe(43200);
  });
  it('rejeita configuração de produção sem TLS e segredos operacionais', () => {
    expect(() => getEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:password@database:5432/rastreia',
      APP_ORIGINS: 'http://app.example.com',
      JWT_ACCESS_SECRET: 'same-secret-with-more-than-32-characters',
      JWT_REFRESH_SECRET: 'same-secret-with-more-than-32-characters',
      TRACKING_TOKEN_PEPPER: 'same-secret-with-more-than-32-characters',
      PUBLIC_TRACKING_BASE_URL: 'http://app.example.com/rastrear',
    })).toThrow();
  });
});
