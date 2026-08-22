import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/config/env.js';
import {
  createPlatformTokenPair, createTokenPair, hashToken, verifyAccessToken,
  verifyPlatformAccessToken, verifyPlatformRefreshToken, verifyRefreshToken,
} from '../src/modules/auth/token.service.js';

const env = {
  JWT_ACCESS_SECRET: 'access-secret-with-more-than-thirty-two-characters',
  JWT_REFRESH_SECRET: 'refresh-secret-with-more-than-thirty-two-characters',
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 3600,
} as AppEnv;

describe('token service', () => {
  it('separa access e refresh e preserva o escopo do tenant', async () => {
    const pair = await createTokenPair(env, {
      userId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      role: 'STORE_OPERATOR',
      storeIds: ['33333333-3333-4333-8333-333333333333'],
    });

    const access = await verifyAccessToken(env, pair.accessToken);
    const refresh = await verifyRefreshToken(env, pair.refreshToken);
    expect(access.tenantId).toBe('22222222-2222-4222-8222-222222222222');
    expect(access.storeIds).toEqual(['33333333-3333-4333-8333-333333333333']);
    expect(refresh.sessionId).toBe(pair.sessionId);
    await expect(verifyAccessToken(env, pair.refreshToken)).rejects.toThrow();
  });

  it('gera hash irreversível estável sem persistir o token', () => {
    expect(hashToken('token')).toHaveLength(64);
    expect(hashToken('token')).toBe(hashToken('token'));
    expect(hashToken('token')).not.toContain('token');
  });

  it('separa criptograficamente a audiência administrativa da audiência tenant', async () => {
    const pair = await createPlatformTokenPair(env, {
      userId: '44444444-4444-4444-8444-444444444444',
    });
    await expect(verifyPlatformAccessToken(env, pair.accessToken)).resolves.toMatchObject({
      userId: '44444444-4444-4444-8444-444444444444', role: 'PLATFORM_ADMIN',
    });
    await expect(verifyPlatformRefreshToken(env, pair.refreshToken)).resolves.toMatchObject({
      sessionId: pair.sessionId,
    });
    await expect(verifyAccessToken(env, pair.accessToken)).rejects.toThrow();
    await expect(verifyPlatformAccessToken(env, pair.refreshToken)).rejects.toThrow();
  });

  it('aceita temporariamente a chave anterior durante rotação', async () => {
    const oldPair = await createTokenPair(env, {
      userId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      role: 'TENANT_MANAGER',
      storeIds: [],
    });
    const rotated = {
      ...env,
      JWT_ACCESS_SECRET: 'new-access-secret-with-more-than-thirty-two-characters',
      JWT_REFRESH_SECRET: 'new-refresh-secret-with-more-than-thirty-two-characters',
      JWT_ACCESS_SECRET_PREVIOUS: env.JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET_PREVIOUS: env.JWT_REFRESH_SECRET,
    };
    await expect(verifyAccessToken(rotated, oldPair.accessToken)).resolves.toMatchObject({
      tenantId: '22222222-2222-4222-8222-222222222222',
    });
    await expect(verifyRefreshToken(rotated, oldPair.refreshToken)).resolves.toMatchObject({
      sessionId: oldPair.sessionId,
    });
  });
});
