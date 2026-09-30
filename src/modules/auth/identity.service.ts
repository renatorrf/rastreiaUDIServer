import argon2 from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import { withRuntimeTransaction, type Database } from '../../database/pool.js';
import { enqueueEmail } from '../../integrations/email/email.service.js';
import { AppError, conflict, unauthorized } from '../../shared/errors.js';
import { createTokenPair, hashToken } from './token.service.js';
import type { TenantRole } from './auth.types.js';
import { normalizeCustomerPhone } from '../customers/customer-phone.js';
import { linkActivationHistory, prepareCustomerActivation } from '../customers/customer-activation.js';

export const passwordOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export interface IdentityAccountRow { id:string; email:string; status:string; password_hash:string; email_verified_at:Date|null; must_change_password:boolean }
const identityClaims = z.object({ sub: z.string().uuid(), sessionId: z.string().uuid(), tokenType: z.enum(['access','refresh']) });
export type Identity = { userId: string; sessionId: string };
export async function setIdentity(client: PoolClient, userId: string) {
  await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
}
export function withIdentity<T>(database: Database, userId: string, callback: (client: PoolClient) => Promise<T>) {
  return withRuntimeTransaction(database, async client => { await setIdentity(client, userId); return callback(client); });
}

async function identityTokens(client: PoolClient, env: AppEnv, userId: string) {
  const sessionId = randomUUID();
  const sign = (tokenType: 'access'|'refresh', secret: string, ttl: number) =>
    new SignJWT({ sessionId, tokenType }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId).setAudience('rastreia-identity').setIssuer('rastreia-backend')
      .setIssuedAt().setExpirationTime(`${ttl}s`).sign(new TextEncoder().encode(secret));
  const accessToken = await sign('access', env.JWT_ACCESS_SECRET, env.ACCESS_TOKEN_TTL_SECONDS);
  const refreshToken = await sign('refresh', env.JWT_REFRESH_SECRET, env.REFRESH_TOKEN_TTL_SECONDS);
  await client.query(`INSERT INTO identity_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)`,
    [sessionId, userId, hashToken(refreshToken), new Date(Date.now()+env.REFRESH_TOKEN_TTL_SECONDS*1000)]);
  return { accessToken, refreshToken, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS };
}
export async function verifyIdentityToken(env: AppEnv, token: string, type: 'access'|'refresh'): Promise<Identity> {
  const secrets = type === 'access' ? [env.JWT_ACCESS_SECRET, env.JWT_ACCESS_SECRET_PREVIOUS]
    : [env.JWT_REFRESH_SECRET, env.JWT_REFRESH_SECRET_PREVIOUS];
  for (const secret of secrets.filter(Boolean)) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(secret),
        { issuer: 'rastreia-backend', audience: 'rastreia-identity', algorithms: ['HS256'] });
      const claims = identityClaims.parse(payload);
      if (claims.tokenType !== type) continue;
      return { userId: claims.sub, sessionId: claims.sessionId };
    } catch { /* Try the previous signing key without disclosing token details. */ }
  }
  throw unauthorized('Sessão inválida ou expirada.');
}
export async function identitySnapshot(client: PoolClient, userId: string) {
  const account = (await client.query(`SELECT id,name,email,must_change_password AS "mustChangePassword" FROM users WHERE id=$1 AND status='ACTIVE'
    AND (email_verified_at IS NOT NULL OR (email IS NULL AND customer_login_phone IS NOT NULL
      AND EXISTS(SELECT 1 FROM customer_profiles WHERE user_id=users.id AND status='ACTIVE')))`, [userId])).rows[0];
  if (!account) throw unauthorized('Verifique seu e-mail antes de acessar.');
  const units = await client.query('SELECT * FROM rastreia.identity_units($1)', [userId]);
  const courier = (await client.query(`SELECT profile.id, profile.status,
    preferences.registration_status AS "registrationStatus"
    FROM courier_profiles profile LEFT JOIN courier_service_preferences preferences
    ON preferences.courier_profile_id=profile.id WHERE profile.user_id=$1`, [userId])).rows[0] ?? null;
  const customer = (await client.query(`SELECT id,tenant_id AS "tenantId",first_name AS "firstName",
    last_name AS "lastName",whatsapp FROM customer_profiles WHERE user_id=$1 AND status='ACTIVE'
    ORDER BY updated_at DESC LIMIT 1`, [userId])).rows[0] ?? null;
  return { user: account, units: units.rows, courier, customer };
}
export async function signInIdentity(database: Database, env: AppEnv, email: string, password: string) {
  return withRuntimeTransaction(database, async client => {
    const account = (await client.query<IdentityAccountRow>(`SELECT * FROM rastreia.identity_by_email($1)`, [email])).rows[0];
    if (!account || account.status !== 'ACTIVE' || !await argon2.verify(account.password_hash, password)) throw unauthorized();
    await setIdentity(client, account.id);
    const snapshot = await identitySnapshot(client, account.id);
    return { ...snapshot, ...await identityTokens(client, env, account.id) };
  });
}
export async function signInCustomer(database: Database, env: AppEnv, whatsapp: string, password: string, trackingToken?: string) {
  const phone = normalizeCustomerPhone(whatsapp);
  return withRuntimeTransaction(database, async client => {
    const account = (await client.query<{ id: string; password_hash: string; status: string }>(
      'SELECT * FROM rastreia.customer_identity_by_phone($1)', [phone])).rows[0];
    if (!account || account.status !== 'ACTIVE' || !await argon2.verify(account.password_hash, password)) throw unauthorized();
    await setIdentity(client, account.id);
    if (trackingToken) {
      try {
        const { profile, tokenId } = await prepareCustomerActivation(client, env, trackingToken, account.id);
        if (profile.whatsapp_normalized !== phone || (profile.user_id && profile.user_id !== account.id)) throw unauthorized();
        await client.query('UPDATE customer_profiles SET user_id=$2,consent_at=COALESCE(consent_at,now()) WHERE id=$1', [profile.id, account.id]);
        await linkActivationHistory(client, env, profile, tokenId);
      } catch (error) {
        // A stale optional order link must not lock an existing account out.
        // No profile or order is linked when its capability has expired.
        if (!(error instanceof AppError) || error.statusCode !== 404) throw error;
      }
    }
    const snapshot = await identitySnapshot(client, account.id);
    return { ...snapshot, ...await identityTokens(client, env, account.id) };
  });
}
export async function assertIdentity(database: Database, env: AppEnv, bearer: string | undefined) {
  if (!bearer?.startsWith('Bearer ')) throw unauthorized();
  const claims = await verifyIdentityToken(env, bearer.slice(7), 'access');
  return withIdentity(database, claims.userId, async client => {
    const result = await client.query(`SELECT 1 FROM identity_sessions session JOIN users account ON account.id=session.user_id
      WHERE session.id=$1 AND session.user_id=$2 AND session.revoked_at IS NULL AND session.expires_at>now()
      AND account.status='ACTIVE' AND (account.email_verified_at IS NOT NULL OR
        (account.email IS NULL AND account.customer_login_phone IS NOT NULL AND EXISTS
          (SELECT 1 FROM customer_profiles WHERE user_id=account.id AND status='ACTIVE')))`, [claims.sessionId, claims.userId]);
    if (!result.rowCount) throw unauthorized();
    return claims;
  });
}
export async function refreshIdentity(database: Database, env: AppEnv, token: string) {
  const claims = await verifyIdentityToken(env, token, 'refresh');
  const result = await withIdentity(database, claims.userId, async client => {
    const session = (await client.query(`SELECT * FROM identity_sessions WHERE id=$1 FOR UPDATE`, [claims.sessionId])).rows[0];
    if (!session || session.token_hash!==hashToken(token) || session.expires_at<=new Date()) throw unauthorized();
    if (session.revoked_at) {
      await client.query('UPDATE identity_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [claims.userId]);
      return null;
    }
    const snapshot = await identitySnapshot(client, claims.userId);
    await client.query('UPDATE identity_sessions SET revoked_at=now() WHERE id=$1', [session.id]);
    return { ...snapshot, ...await identityTokens(client, env, claims.userId) };
  });
  if (!result) throw unauthorized('Reuso de sessão detectado; entre novamente.');
  return result;
}
export async function enterUnit(database: Database, env: AppEnv, identity: Identity, storeId: string) {
  return withIdentity(database, identity.userId, async client => {
    const accountState=(await client.query<{must_change_password:boolean}>(
      'SELECT must_change_password FROM users WHERE id=$1',[identity.userId])).rows[0];
    if(accountState?.must_change_password) throw conflict('Defina sua senha pessoal antes de continuar.');
    const unit = (await client.query<{ id:string; name:string; tenant_id:string; tenant_slug:string; tenant_name:string; role:TenantRole }>(
      'SELECT * FROM rastreia.identity_units($1) WHERE id=$2', [identity.userId, storeId])).rows[0];
    if (!unit) throw unauthorized('Unidade indisponível para esta conta.');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [unit.tenant_id]);
    const tokens = await createTokenPair(env, { userId: identity.userId, tenantId: unit.tenant_id, role: unit.role, storeIds: [unit.id] });
    await client.query(`INSERT INTO refresh_sessions(id,tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)`,
      [tokens.sessionId, unit.tenant_id, identity.userId, hashToken(tokens.refreshToken), tokens.refreshExpiresAt]);
    const account = (await client.query('SELECT id,name,email FROM users WHERE id=$1', [identity.userId])).rows[0];
    const tenant = (await client.query('SELECT id,slug,name,timezone FROM tenants WHERE id=$1', [unit.tenant_id])).rows[0];
    return { ...tokens, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      user: { ...account, role: unit.role, storeIds: [unit.id] }, tenant };
  });
}

export async function changeOwnPassword(database: Database, identity: Identity, currentPassword: string, newPassword: string) {
  return withIdentity(database, identity.userId, async client => {
    const account=(await client.query<{password_hash:string}>(
      'SELECT password_hash FROM users WHERE id=$1 FOR UPDATE',[identity.userId])).rows[0];
    if(!account || !await argon2.verify(account.password_hash,currentPassword)) throw unauthorized('A senha temporária não confere.');
    if(currentPassword===newPassword) throw conflict('A nova senha deve ser diferente da senha temporária.');
    await client.query('UPDATE users SET password_hash=$2,must_change_password=false,updated_at=now() WHERE id=$1',
      [identity.userId,await argon2.hash(newPassword,passwordOptions)]);
    await client.query('UPDATE identity_sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL',
      [identity.userId,identity.sessionId]);
    return identitySnapshot(client,identity.userId);
  });
}

export async function createIdentityAction(client: PoolClient, env: AppEnv, input: {
  userId:string; email:string; kind:'INVITE'|'VERIFY_EMAIL'|'RESET_PASSWORD';
  tenantId?:string; storeId?:string; requiresPassword?:boolean;
}) {
  const id=randomUUID(); const token=randomBytes(32).toString('base64url');
  const expiresAt=new Date(Date.now()+(input.kind==='RESET_PASSWORD'?3600:86400)*1000);
  await client.query(`UPDATE identity_actions SET consumed_at=now() WHERE user_id=$1 AND kind=$2 AND consumed_at IS NULL
    AND ($3::uuid IS NULL OR store_id=$3)`, [input.userId,input.kind,input.storeId??null]);
  await client.query(`INSERT INTO identity_actions(id,user_id,kind,token_hash,tenant_id,store_id,requires_password,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id,input.userId,input.kind,hashToken(token),input.tenantId??null,
      input.storeId??null,input.requiresPassword??false,expiresAt]);
  const path = input.kind==='INVITE'?'convite':input.kind==='VERIFY_EMAIL'?'verificar-email':'redefinir-senha';
  // Fragments are not sent to the web server or included in referrers.
  const url=new URL(`/${path}`,env.EMAIL_ACTION_BASE_URL); url.hash=token;
  await enqueueEmail(client,env,`identity:${id}`,{to:input.email,subject:'RastreiaAPP — confirme seu acesso',
    text:`Para ${input.kind==='RESET_PASSWORD'?'redefinir sua senha':'confirmar seu acesso'}, abra: ${url.toString()}\nEste link é temporário. Se você não solicitou, ignore esta mensagem.`},expiresAt);
  return { actionId:id, expiresAt };
}
export async function consumeIdentityAction(database: Database, env: AppEnv, token: string,
  kind:'INVITE'|'VERIFY_EMAIL'|'RESET_PASSWORD', password?:string, inspect=false) {
  return withRuntimeTransaction(database, async client => {
    const userId=(await client.query<{id:string|null}>('SELECT rastreia.identity_action_user($1) AS id',[hashToken(token)])).rows[0]?.id;
    if (!userId) throw conflict('Link inválido ou expirado. Solicite um novo.');
    await setIdentity(client,userId);
    const action=(await client.query(`SELECT * FROM identity_actions WHERE token_hash=$1 AND kind=$2
      AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,[hashToken(token),kind])).rows[0];
    if (!action) throw conflict('Link inválido ou expirado. Solicite um novo.');
    if (inspect) return {requiresPassword:action.requires_password || kind==='RESET_PASSWORD'};
    if (kind==='RESET_PASSWORD' || action.requires_password) {
      if (!password || password.length<12) throw conflict('Informe uma senha de pelo menos 12 caracteres.');
      await client.query('UPDATE users SET password_hash=$2,must_change_password=false WHERE id=$1',[userId,await argon2.hash(password,passwordOptions)]);
      // Reset all sessions/legacy per-company overrides via a narrow, token-authorized function.
      await client.query('SELECT rastreia.revoke_identity_credentials($1)',[userId]);
    }
    await client.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1',[userId]);
    await client.query('UPDATE identity_actions SET consumed_at=now() WHERE id=$1',[action.id]);
    await client.query(`UPDATE courier_service_preferences SET registration_status='IN_REVIEW',updated_at=now()
        WHERE courier_profile_id IN (SELECT id FROM courier_profiles WHERE user_id=$1) AND registration_status='EMAIL_PENDING'`,[userId]);
    return { confirmed:true };
  });
}
