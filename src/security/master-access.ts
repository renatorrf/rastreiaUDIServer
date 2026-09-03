import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { AppEnv } from '../config/env.js';
import { AppError } from '../shared/errors.js';

const issuer = 'rastreia-backend';
const audience = 'rastreia-master-login-gate';
const lifetime = 300;
type GateEnv = Pick<AppEnv, 'MASTER_ACCESS_TOKEN' | 'JWT_ACCESS_SECRET'>;

function signingKey(env: GateEnv): Buffer {
  if (!env.MASTER_ACCESS_TOKEN || env.MASTER_ACCESS_TOKEN.length < 32) {
    throw new AppError(503, 'MASTER_ACCESS_UNAVAILABLE', 'Acesso master indisponível. Contate o administrador.');
  }
  // Domain separation and token rotation invalidate grants without rotating JWT sessions.
  return createHmac('sha256', env.JWT_ACCESS_SECRET).update(`${audience}\0${env.MASTER_ACCESS_TOKEN}`).digest();
}

const denied = () => new AppError(403, 'MASTER_ACCESS_REQUIRED', 'Valide o token de acesso master para continuar.');

export async function createMasterLoginGrant(env: GateEnv, token: string) {
  const key = signingKey(env);
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(token), digest(env.MASTER_ACCESS_TOKEN))) throw denied();
  const grant = await new SignJWT({ purpose: 'master-login' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer(issuer).setAudience(audience)
    .setSubject('master-entry').setJti(randomUUID()).setIssuedAt().setExpirationTime(`${lifetime}s`).sign(key);
  return { grant, expiresIn: lifetime };
}

export async function verifyMasterLoginGrant(env: GateEnv, grant: unknown): Promise<void> {
  const key = signingKey(env);
  if (typeof grant !== 'string' || grant.length > 2048) throw denied();
  try {
    const { payload } = await jwtVerify(grant, key, {
      algorithms: ['HS256'], issuer, audience, subject: 'master-entry', maxTokenAge: `${lifetime}s`,
      requiredClaims: ['exp', 'iat', 'jti', 'sub'],
    });
    if (payload.purpose !== 'master-login') throw denied();
  } catch { throw denied(); }
}
