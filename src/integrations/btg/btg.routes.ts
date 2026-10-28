import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { authenticate, requireRoles } from '../../modules/auth/auth.guard.js';
import { confirmManagerPassword } from '../../modules/auth/confirm-manager-password.js';
import { AppError } from '../../shared/errors.js';
import { createBtgStore, type BtgStore } from './btg.store.js';
import { BTG_CALLBACK, BtgTokenExchangeError, authorizationUrl, btgConfig,btgInfrastructure,assertStateCredentials,stateAuth, createState, exchangeCode, hash, invalidAuthorization, readState } from './btg.oauth.js';

const cookieName = '__Secure-rastreia-btg';
const cookieOptions = { path: BTG_CALLBACK, httpOnly:true, secure:true, sameSite:'none' as const, maxAge:600 };
const querySchema = z.object({ state:z.string().min(1).max(16384), code:z.string().min(1).max(4096).optional(),
  iss:z.string().max(200).optional(), error:z.string().max(200).optional() });

function resultPage(reply: FastifyReply, status: number, success: boolean) {
  const nonce = randomBytes(16).toString('base64');
  reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Robots-Tag','noindex, nofollow')
    .header('Content-Security-Policy',`default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  return reply.status(status).type('text/html; charset=utf-8').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autorização BTG · RastreiaAPP</title><style nonce="${nonce}">body{margin:0;background:#101418;color:#f3f5f7;font:16px/1.6 system-ui}main{max-width:600px;margin:12vh auto;padding:24px}small{color:#2ccc80}h1{font-size:28px;line-height:1.3}p{color:#bbc3cb}</style></head><body><main><small>RASTREIAAPP · BTG</small><h1>${success?'Autorização recebida':'Não foi possível concluir a autorização'}</h1><p>${success?'O retorno do BTG foi recebido com segurança. A conta bancária ainda precisa ser validada antes de liberar cobranças ou recebimentos. Nenhum pagamento foi realizado.':'A autorização pode ter expirado, sido recusada ou já utilizada, ou o serviço pode estar indisponível. Volte à conta do gestor e inicie uma nova tentativa no mesmo navegador.'}</p><p>Você pode fechar esta janela e voltar ao RastreiaAPP.</p></main></body></html>`);
}

export async function btgRoutes(app:FastifyInstance,database:Database,env:AppEnv,
  dependencies:{store?:BtgStore;fetcher?:typeof fetch}={}) {
  const store=dependencies.store??createBtgStore(database,env);
  app.post('/companies/:id/integrations/btg/authorization', {
    preHandler:[authenticate(env,database),requireRoles('TENANT_MANAGER'),confirmManagerPassword(database)],
    config:{rateLimit:{max:5,timeWindow:'1 minute'}},
  },async(request,reply)=>{
    const companyId=z.object({id:z.uuid()}).parse(request.params).id;
    btgInfrastructure(env);
    const credentials=await store.configuration(request.auth,companyId);
    const {state,ticket}=createState(env,request.auth,companyId,credentials);
    const browser=randomBytes(32).toString('base64url');
    await store.begin(state,hash(ticket),hash(browser));
    return reply.header('Cache-Control','no-store').setCookie(cookieName,browser,cookieOptions)
      .send({authorizationUrl:authorizationUrl(env,ticket,credentials),expiresAt:new Date(state.exp).toISOString()});
  });
  app.get(BTG_CALLBACK,{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(request,reply)=>{
    let stage:'configuration'|'state'|'browser'|'company'|'issuer'|'consume'|'exchange'|'save'='configuration';
    try {
      btgInfrastructure(env);
      stage='state';
      const query=querySchema.parse(request.query);
      const state=readState(env,query.state),browser=request.cookies[cookieName];
      stage='browser';
      if (!browser || !/^[A-Za-z0-9_-]{43}$/.test(browser)) throw invalidAuthorization();
      stage='company';
      const credentials=await store.configuration(stateAuth(state),state.companyId);
      assertStateCredentials(state,credentials);
      const config=btgConfig(env,credentials);
      stage='issuer';
      if (query.iss !== config.issuer || Boolean(query.code) === Boolean(query.error)) throw invalidAuthorization();
      // Commit one-time consumption before any network call; timeout/failure requires a fresh authorization.
      stage='consume';
      if (!await store.consume(state,hash(query.state),hash(browser))) throw invalidAuthorization();
      reply.clearCookie(cookieName,cookieOptions);
      if (query.error) {
        request.log.warn({reason:'BTG_AUTHORIZATION_NOT_GRANTED',stage:'provider_response'},'BTG authorization not completed');
        return resultPage(reply,400,false);
      }
      stage='exchange';
      const tokens=await exchangeCode(env,query.code!,credentials,dependencies.fetcher);
      stage='save';
      await store.save(state,hash(query.state),tokens);
      return resultPage(reply,200,true);
    } catch(error) {
      const status=error instanceof AppError?error.statusCode:400;
      // Only fixed reason codes; never log callback URL, query, provider response or exception objects.
      request.log.warn({reason:error instanceof AppError?error.code:'BTG_CALLBACK_REJECTED',stage,
        ...(error instanceof BtgTokenExchangeError?{diagnostic:error.diagnostic}:{})},'BTG authorization not completed');
      return resultPage(reply,status,false);
    }
  });
}
