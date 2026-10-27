import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { AuthContext } from '../../modules/auth/auth.types.js';
import { encryptPayload, decryptPayload } from '../../shared/encrypted-payload.js';
import { AppError } from '../../shared/errors.js';

export const BTG_CALLBACK = '/integrations/btg/callback';
export const BTG_SCOPE = 'openid empresas.btgpactual.com/pix-cash-in';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface BtgCredentials { mode:'sandbox'|'production';clientId:string;clientSecret:string;version:number; }
const stateSchema = z.object({ purpose: z.literal('btg-authorization'), companyId: z.uuid(),
  tenantId: z.uuid(), userId: z.uuid(), storeIds: z.array(z.uuid()), sessionId: z.string(),
  mode: z.enum(['sandbox', 'production']), clientId: z.string(), redirectUri: z.string(), settingsVersion:z.number().int().positive(),
  nonce: z.string(), exp: z.number() });
export type BtgState = z.infer<typeof stateSchema>;
export function stateAuth(state: BtgState): AuthContext { return { ...state, role: 'TENANT_MANAGER' }; }
export function invalidAuthorization() { return new AppError(400, 'BTG_AUTHORIZATION_INVALID', 'Autorização inválida, expirada ou já utilizada. Inicie novamente pela conta do gestor.'); }
export function btgInfrastructure(env: AppEnv) {
  if (!env.BTG_ENABLED || !env.BTG_ENCRYPTION_SECRET || env.BTG_ENCRYPTION_SECRET.length < 32) {
    throw new AppError(503, 'BTG_NOT_CONFIGURED', 'A autorização BTG ainda não está configurada.');
  }
  const redirect = new URL(env.BTG_REDIRECT_URI);
  if (redirect.protocol !== 'https:' || redirect.pathname !== BTG_CALLBACK || redirect.search || redirect.hash || redirect.username || redirect.password) throw invalidAuthorization();
  return {redirect};
}
export function btgConfig(env:AppEnv,credentials:BtgCredentials){
  const {redirect}=btgInfrastructure(env);
  if(!credentials.clientId||!credentials.clientSecret||credentials.version<1)throw invalidAuthorization();
  return {redirect,issuer:credentials.mode==='production'?'https://id.btgpactual.com':'https://id.sandbox.btgpactual.com'};
}
export function assertStateCredentials(state:BtgState,credentials:BtgCredentials){
  if(state.mode!==credentials.mode||state.clientId!==credentials.clientId||state.settingsVersion!==credentials.version)throw invalidAuthorization();
}
export function createState(env: AppEnv, auth: AuthContext, companyId: string, credentials:BtgCredentials) {
  btgConfig(env,credentials);
  const state: BtgState = { purpose: 'btg-authorization', companyId, tenantId: auth.tenantId,
    userId: auth.userId, storeIds: auth.storeIds, sessionId: auth.sessionId,
    mode: credentials.mode, clientId: credentials.clientId,settingsVersion:credentials.version,redirectUri: env.BTG_REDIRECT_URI,
    nonce: randomBytes(32).toString('base64url'), exp: Date.now() + 10 * 60_000 };
  return { state, ticket: encryptPayload(state, env.BTG_ENCRYPTION_SECRET) };
}
export function readState(env: AppEnv, ticket: string): BtgState {
  try {
    if (!ticket || ticket.length > 16_384) throw invalidAuthorization();
    const state = stateSchema.parse(decryptPayload(ticket, env.BTG_ENCRYPTION_SECRET));
    if (state.exp <= Date.now() || state.redirectUri !== env.BTG_REDIRECT_URI) throw invalidAuthorization();
    return state;
  } catch { throw invalidAuthorization(); }
}
export function authorizationUrl(env: AppEnv, ticket: string,credentials:BtgCredentials) {
  const url = new URL('/oauth2/authorize', btgConfig(env,credentials).issuer);
  url.search = new URLSearchParams({ client_id: credentials.clientId, response_type: 'code',
    redirect_uri: env.BTG_REDIRECT_URI, scope: BTG_SCOPE, prompt: 'login', state: ticket }).toString();
  return url.href;
}
export const tokenSchema = z.object({ access_token: z.string().min(1).max(32768),
  refresh_token: z.string().min(1).max(32768), token_type: z.string().refine(v => v.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive().max(31_536_000), scope: z.string().max(4096) });
export type BtgTokens = z.infer<typeof tokenSchema>;
export async function exchangeCode(env: AppEnv, code: string, credentials:BtgCredentials,fetcher: typeof fetch = fetch): Promise<BtgTokens> {
  try {
    const response = await fetcher(`${btgConfig(env,credentials).issuer}/oauth2/token`, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}` },
      body: new URLSearchParams({ code, redirect_uri: env.BTG_REDIRECT_URI, grant_type: 'authorization_code' }) });
    if (!response.ok) throw new Error();
    const tokens = tokenSchema.parse(await response.json());
    if (!BTG_SCOPE.split(' ').every(scope => tokens.scope.split(' ').includes(scope))) throw new Error();
    return tokens;
  } catch {
    // Never propagate provider bodies, authorization codes or tokens to logs/clients.
    throw new AppError(502, 'BTG_TOKEN_EXCHANGE_FAILED', 'Não foi possível concluir a autorização com o BTG. Inicie uma nova tentativa.');
  }
}
