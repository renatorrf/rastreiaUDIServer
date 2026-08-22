import { createHash, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { AuthContext, PlatformAuthContext, TenantRole } from './auth.types.js';

const encoder = new TextEncoder();
const issuer = 'rastreia-backend';
const audience = 'rastreia-app';
const platformAudience = 'rastreia-platform';

const claimsSchema = z.object({
  sub: z.string().uuid(),
  tenantId: z.string().uuid(),
  role: z.enum(['TENANT_MANAGER', 'STORE_OPERATOR', 'COURIER']),
  storeIds: z.array(z.string().uuid()),
  sessionId: z.string().uuid(),
  tokenType: z.enum(['access', 'refresh']),
});

const platformClaimsSchema = z.object({
  sub: z.string().uuid(),
  role: z.literal('PLATFORM_ADMIN'),
  sessionId: z.string().uuid(),
  tokenType: z.enum(['access', 'refresh']),
});

interface TokenSubject {
  userId: string;
  tenantId: string;
  role: TenantRole;
  storeIds: string[];
  sessionId?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  refreshExpiresAt: Date;
}

async function sign(
  subject: Required<TokenSubject>,
  tokenType: 'access' | 'refresh',
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({
    tenantId: subject.tenantId,
    role: subject.role,
    storeIds: subject.storeIds,
    sessionId: subject.sessionId,
    tokenType,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject.userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(encoder.encode(secret));
}

export async function createTokenPair(env: AppEnv, subject: TokenSubject): Promise<TokenPair> {
  const complete = { ...subject, sessionId: subject.sessionId ?? randomUUID() } as Required<TokenSubject>;
  const [accessToken, refreshToken] = await Promise.all([
    sign(complete, 'access', env.JWT_ACCESS_SECRET, env.ACCESS_TOKEN_TTL_SECONDS),
    sign(complete, 'refresh', env.JWT_REFRESH_SECRET, env.REFRESH_TOKEN_TTL_SECONDS),
  ]);

  return {
    accessToken,
    refreshToken,
    sessionId: complete.sessionId,
    refreshExpiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000),
  };
}

export async function createPlatformTokenPair(
  env: AppEnv,
  subject: { userId: string; sessionId?: string },
): Promise<TokenPair> {
  const sessionId = subject.sessionId ?? randomUUID();
  const signPlatform = (tokenType: 'access' | 'refresh', secret: string, ttlSeconds: number) => new SignJWT({
    role: 'PLATFORM_ADMIN', sessionId, tokenType,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(platformAudience)
    .setSubject(subject.userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(encoder.encode(secret));
  const [accessToken, refreshToken] = await Promise.all([
    signPlatform('access', env.JWT_ACCESS_SECRET, env.ACCESS_TOKEN_TTL_SECONDS),
    signPlatform('refresh', env.JWT_REFRESH_SECRET, env.REFRESH_TOKEN_TTL_SECONDS),
  ]);
  return {
    accessToken, refreshToken, sessionId,
    refreshExpiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000),
  };
}

async function verify(token: string, secret: string, expectedType: 'access' | 'refresh'): Promise<AuthContext> {
  const result = await jwtVerify(token, encoder.encode(secret), { issuer, audience });
  const claims = claimsSchema.parse(result.payload);
  if (claims.tokenType !== expectedType) throw new Error('Tipo de token inválido.');

  return {
    userId: claims.sub,
    tenantId: claims.tenantId,
    role: claims.role,
    storeIds: claims.storeIds,
    sessionId: claims.sessionId,
  };
}

export const verifyAccessToken = (env: AppEnv, token: string) =>
  verifyWithFallback(token, env.JWT_ACCESS_SECRET, env.JWT_ACCESS_SECRET_PREVIOUS, 'access');

export const verifyRefreshToken = (env: AppEnv, token: string) =>
  verifyWithFallback(token, env.JWT_REFRESH_SECRET, env.JWT_REFRESH_SECRET_PREVIOUS, 'refresh');

async function verifyPlatform(
  token: string,
  secret: string,
  expectedType: 'access' | 'refresh',
): Promise<PlatformAuthContext> {
  const result = await jwtVerify(token, encoder.encode(secret), { issuer, audience: platformAudience });
  const claims = platformClaimsSchema.parse(result.payload);
  if (claims.tokenType !== expectedType) throw new Error('Tipo de token inválido.');
  return { userId: claims.sub, role: claims.role, sessionId: claims.sessionId };
}

async function verifyPlatformWithFallback(
  env: AppEnv,
  token: string,
  expectedType: 'access' | 'refresh',
): Promise<PlatformAuthContext> {
  const current = expectedType === 'access' ? env.JWT_ACCESS_SECRET : env.JWT_REFRESH_SECRET;
  const previous = expectedType === 'access' ? env.JWT_ACCESS_SECRET_PREVIOUS : env.JWT_REFRESH_SECRET_PREVIOUS;
  try { return await verifyPlatform(token, current, expectedType); }
  catch (error) {
    if (!previous) throw error;
    return verifyPlatform(token, previous, expectedType);
  }
}

export const verifyPlatformAccessToken = (env: AppEnv, token: string) =>
  verifyPlatformWithFallback(env, token, 'access');

export const verifyPlatformRefreshToken = (env: AppEnv, token: string) =>
  verifyPlatformWithFallback(env, token, 'refresh');

async function verifyWithFallback(
  token: string,
  currentSecret: string,
  previousSecret: string,
  expectedType: 'access' | 'refresh',
): Promise<AuthContext> {
  try {
    return await verify(token, currentSecret, expectedType);
  } catch (error) {
    if (!previousSecret) throw error;
    return verify(token, previousSecret, expectedType);
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
