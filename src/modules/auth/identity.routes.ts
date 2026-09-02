import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withRuntimeTransaction, type Database } from '../../database/pool.js';
import { AppError, unauthorized } from '../../shared/errors.js';
import { sessionCookieOptions } from '../../shared/session-cookie.js';
import { emailConfigured } from '../../integrations/email/email.service.js';
import { assertIdentity, consumeIdentityAction, createIdentityAction, enterUnit, identitySnapshot,
  passwordOptions, refreshIdentity, setIdentity, signInIdentity, verifyIdentityToken, withIdentity } from './identity.service.js';
import { courierPreferencesSchema } from '../couriers/courier-account.routes.js';
import type { IdentityAccountRow } from './identity.service.js';
import { logout } from './auth.service.js';

const emailSchema=z.object({email:z.string().trim().email().toLowerCase()});
const tokenSchema=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),password:z.string().min(12).max(200).optional()});
const registrationSchema=courierPreferencesSchema.extend({
  name:z.string().trim().min(2).max(160),email:z.string().trim().email().toLowerCase(),password:z.string().min(12).max(200),
  phone:z.string().trim().regex(/^\+?[0-9 ()-]{10,25}$/),
  vehicleType:z.enum(['BICYCLE','MOTORCYCLE','CAR','VAN','ON_FOOT','OTHER']),
  acceptedTerms:z.literal(true),acceptedPrivacy:z.literal(true),legalVersion:z.string().min(1),
});
const genericMessage={message:'Se os dados permitirem, você receberá um e-mail com as próximas instruções.'};
export const registrationEnabled=(env:AppEnv)=>Boolean(env.PUBLIC_COURIER_REGISTRATION_ENABLED && emailConfigured(env)
  && /^https:\/\//.test(env.TERMS_URL) && /^https:\/\//.test(env.PRIVACY_URL));

export async function identityRoutes(app:FastifyInstance,database:Database,env:AppEnv) {
  const limited={config:{rateLimit:{max:5,timeWindow:'15 minutes'}}};
  const sendIdentity=(reply:FastifyReply,result:Awaited<ReturnType<typeof signInIdentity>>)=>{
    const {refreshToken,...body}=result;
    reply.setCookie('rastreia_identity_refresh',refreshToken,sessionCookieOptions(env,'/auth/identity'));
    reply.header('Cache-Control','no-store'); return body;
  };
  app.post('/auth/sign-in',limited,async(request,reply)=>{
    const input=emailSchema.extend({password:z.string().min(8).max(200)}).parse(request.body);
    return sendIdentity(reply,await signInIdentity(database,env,input.email,input.password));
  });
  app.post('/auth/identity/refresh',async(request,reply)=>{
    const token=request.cookies['rastreia_identity_refresh']; if(!token) throw unauthorized();
    return sendIdentity(reply,await refreshIdentity(database,env,token));
  });
  app.post('/auth/identity/logout',async(request,reply)=>{
    const operational=request.cookies['rastreia_refresh'];
    if(operational)await logout(database,env,operational);
    reply.clearCookie('rastreia_refresh',sessionCookieOptions(env,'/auth'));
    const token=request.cookies['rastreia_identity_refresh'];
    if(token) { try {const claims=await verifyIdentityToken(env,token,'refresh');
      await withIdentity(database,claims.userId,async client=>{
        await client.query('UPDATE identity_sessions SET revoked_at=now() WHERE id=$1',[claims.sessionId]);
        await client.query(`UPDATE courier_service_preferences SET availability_status='OFFLINE',latitude=NULL,longitude=NULL,accuracy=NULL,
          location_authorized_at=NULL,location_expires_at=NULL,updated_at=now()
          WHERE courier_profile_id IN (SELECT id FROM courier_profiles WHERE user_id=$1)`,[claims.userId]);
      });
    } catch { /* Logout is deliberately idempotent. */ } }
    reply.clearCookie('rastreia_identity_refresh',sessionCookieOptions(env,'/auth/identity')); return reply.code(204).send();
  });
  app.get('/auth/identity/me',async request=>{
    const identity=await assertIdentity(database,env,request.headers.authorization);
    return withIdentity(database,identity.userId,client=>identitySnapshot(client,identity.userId));
  });
  app.post('/auth/enter-unit',async(request,reply)=>{
    const identity=await assertIdentity(database,env,request.headers.authorization);
    const {storeId}=z.object({storeId:z.string().uuid()}).parse(request.body);
    const result=await enterUnit(database,env,identity,storeId);
    reply.setCookie('rastreia_refresh',result.refreshToken,sessionCookieOptions(env,'/auth'));
    return {accessToken:result.accessToken,expiresIn:result.expiresIn,user:result.user,tenant:result.tenant};
  });
  for(const [path,kind] of [['/auth/accept-invite','INVITE'],['/auth/reset-password','RESET_PASSWORD'],
    ['/public/couriers/verify-email','VERIFY_EMAIL']] as const) {
    app.post(path,limited,async(request,reply)=>{
      const input=tokenSchema.parse(request.body);reply.header('Cache-Control','no-store');
      return consumeIdentityAction(database,env,input.token,kind,input.password);
    });
  }
  app.post('/auth/inspect-invite',limited,async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    return consumeIdentityAction(database,env,tokenSchema.parse(request.body).token,'INVITE',undefined,true);
  });
  for(const [path,kind] of [['/auth/forgot-password','RESET_PASSWORD'],['/public/couriers/resend-verification','VERIFY_EMAIL']] as const) {
    app.post(path,limited,async(request,reply)=>{
      const {email}=emailSchema.parse(request.body);
      await withRuntimeTransaction(database,async client=>{
        const account=(await client.query<IdentityAccountRow>('SELECT * FROM rastreia.identity_by_email($1)',[email])).rows[0];
        if(!account || account.status!=='ACTIVE' || (kind==='VERIFY_EMAIL' && account.email_verified_at)) return;
        await setIdentity(client,account.id);
        await createIdentityAction(client,env,{userId:account.id,email,kind});
      });
      return reply.code(202).send(genericMessage);
    });
  }
  app.get('/public/registration-config',async()=>({enabled:registrationEnabled(env),
    termsUrl:env.TERMS_URL,privacyUrl:env.PRIVACY_URL,legalVersion:env.LEGAL_DOCUMENTS_VERSION}));
  app.post('/public/couriers/register',limited,async(request,reply)=>{
    if(!registrationEnabled(env)) throw new AppError(503,'REGISTRATION_UNAVAILABLE','O cadastro público aguarda configuração do envio de e-mail e das políticas.');
    const input=registrationSchema.parse(request.body);
    if(input.legalVersion!==env.LEGAL_DOCUMENTS_VERSION) throw new AppError(409,'LEGAL_VERSION_CHANGED','Recarregue os termos antes de continuar.');
    const hash=await argon2.hash(input.password,passwordOptions);
    try {await withRuntimeTransaction(database,async client=>{
      const exists=(await client.query('SELECT id FROM rastreia.identity_by_email($1)',[input.email])).rowCount;
      if(exists) return;
      const userId=randomUUID();
      const profileId=(await client.query('SELECT rastreia.register_courier_identity($1,$2,$3,$4,$5,$6) AS id',
        [userId,input.name,input.email,hash,input.phone.replace(/[^\d+]/g,''),input.vehicleType])).rows[0].id;
      if (!profileId) return;
      await setIdentity(client,userId);
      await client.query(`INSERT INTO courier_service_preferences(courier_profile_id,base_city,reference_region,radius_m,
        interests,modalities,availability_windows,terms_version,privacy_version)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$8)`,[profileId,input.baseCity,input.referenceRegion,input.radiusM,
        JSON.stringify(input.interests),input.modalities,JSON.stringify(input.availabilityWindows),input.legalVersion]);
      await createIdentityAction(client,env,{userId,email:input.email,kind:'VERIFY_EMAIL'});
    });} catch(error) {if((error as {code?:string}).code!=='23505') throw error;}
    return reply.code(202).send(genericMessage);
  });
}
