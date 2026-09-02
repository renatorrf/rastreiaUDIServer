import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withPlatformTransaction, type Database } from '../../database/pool.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { authenticatePlatform } from '../auth/auth.guard.js';
import { assertIdentity, withIdentity } from '../auth/identity.service.js';

export const courierPreferencesSchema=z.object({
  baseCity:z.string().trim().min(2).max(120),referenceRegion:z.string().trim().max(200).default(''),
  radiusM:z.number().int().min(500).max(100000),interests:z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  modalities:z.array(z.enum(['FIXED_SHIFT','REPLACEMENT','ONE_OFF'])).min(1).max(3),
  availabilityWindows:z.array(z.object({day:z.number().int().min(0).max(6),
    start:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),end:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  }).refine(window=>window.end>window.start,{message:'O fim deve ser depois do início.'})).max(28).default([]),
});
export async function courierAccountRoutes(app:FastifyInstance,database:Database,env:AppEnv) {
  app.get('/courier/profile',async request=>{
    const identity=await assertIdentity(database,env,request.headers.authorization);
    return withIdentity(database,identity.userId,async client=>{
      const profile=(await client.query(`SELECT p.id,p.phone,p.vehicle_type AS "vehicleType",p.status,
        preferences.* FROM courier_profiles p LEFT JOIN courier_service_preferences preferences ON preferences.courier_profile_id=p.id
        WHERE p.user_id=$1`,[identity.userId])).rows[0];
      if(!profile) throw notFound();return profile;
    });
  });
  app.put('/courier/service-preferences',async request=>{
    const identity=await assertIdentity(database,env,request.headers.authorization);
    const input=courierPreferencesSchema.extend({acceptedTerms:z.boolean().optional(),acceptedPrivacy:z.boolean().optional(),legalVersion:z.string().optional()}).parse(request.body);
    return withIdentity(database,identity.userId,async client=>{
      const profile=(await client.query<{id:string;status:string}>('SELECT id,status FROM courier_profiles WHERE user_id=$1',[identity.userId])).rows[0];
      if(!profile)throw notFound();
      const existing=await client.query('SELECT 1 FROM courier_service_preferences WHERE courier_profile_id=$1',[profile.id]);
      if(!existing.rowCount){
        if(!input.acceptedTerms||!input.acceptedPrivacy||input.legalVersion!==env.LEGAL_DOCUMENTS_VERSION
          ||!/^https:\/\//.test(env.TERMS_URL)||!/^https:\/\//.test(env.PRIVACY_URL))throw conflict('Leia e aceite os termos e a política de privacidade vigentes para concluir suas preferências.');
        await client.query(`INSERT INTO courier_service_preferences(courier_profile_id,registration_status,base_city,radius_m,terms_version,privacy_version)
          VALUES($1,$2,$3,$4,$5,$5)`,[profile.id,profile.status==='ACTIVE'?'APPROVED':'IN_REVIEW',input.baseCity,input.radiusM,input.legalVersion]);
      }
      const result=await client.query(`UPDATE courier_service_preferences SET base_city=$2,reference_region=$3,radius_m=$4,
        interests=$5::jsonb,modalities=$6,availability_windows=$7::jsonb,updated_at=now()
        WHERE courier_profile_id IN (SELECT id FROM courier_profiles WHERE user_id=$1) RETURNING courier_profile_id`,
      [identity.userId,input.baseCity,input.referenceRegion,input.radiusM,JSON.stringify(input.interests),input.modalities,JSON.stringify(input.availabilityWindows)]);
      if(!result.rowCount) throw notFound('Preferências não encontradas.');return {saved:true};
    });
  });
  for(const action of ['start','pause','stop'] as const) {
    app.post(`/courier/availability/${action}`,async request=>{
      const identity=await assertIdentity(database,env,request.headers.authorization);
      const point=action==='start'?z.object({latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180),
        accuracy:z.number().min(0).max(100),locationConsent:z.literal(true)}).parse(request.body):null;
      return withIdentity(database,identity.userId,async client=>{
        const profile=(await client.query(`SELECT p.id,p.status,preferences.registration_status FROM courier_profiles p
          JOIN courier_service_preferences preferences ON preferences.courier_profile_id=p.id WHERE p.user_id=$1 FOR UPDATE`,[identity.userId])).rows[0];
        if(!profile) throw notFound();
        if(action==='start' && (profile.status!=='ACTIVE'||profile.registration_status!=='APPROVED')) {
          throw forbidden('Seu cadastro precisa estar aprovado para ficar disponível.');
        }
        await client.query(`UPDATE courier_service_preferences SET availability_status=$2,latitude=$3,longitude=$4,accuracy=$5,
          location_authorized_at=CASE WHEN $2='AVAILABLE' THEN now() ELSE NULL END,
          location_expires_at=CASE WHEN $2='AVAILABLE' THEN now()+interval '5 minutes' ELSE NULL END,updated_at=now()
          WHERE courier_profile_id=$1`,[profile.id,action==='start'?'AVAILABLE':action==='pause'?'PAUSED':'OFFLINE',
          point?.latitude??null,point?.longitude??null,point?.accuracy??null]);
        return {status:action==='start'?'AVAILABLE':action==='pause'?'PAUSED':'OFFLINE',locationExpiresIn:point?300:0};
      });
    });
  }
  const master=authenticatePlatform(env,database);
  app.get('/platform/courier-registrations',{preHandler:master},async request=>withPlatformTransaction(database,request.platformAuth,async client=>{
    const result=await client.query(`SELECT p.id,u.name,u.email,p.phone,p.vehicle_type AS "vehicleType",preferences.registration_status AS status,
      preferences.base_city AS "baseCity",u.email_verified_at AS "emailVerifiedAt" FROM courier_service_preferences preferences
      JOIN courier_profiles p ON p.id=preferences.courier_profile_id JOIN users u ON u.id=p.user_id ORDER BY preferences.updated_at DESC LIMIT 100`);
    return {data:result.rows};
  }));
  app.post('/platform/courier-registrations/:id/review',{preHandler:master},async request=>{
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const input=z.object({status:z.enum(['APPROVED','REJECTED','SUSPENDED']),reason:z.string().trim().min(5).max(500)}).parse(request.body);
    return withPlatformTransaction(database,request.platformAuth,async client=>{
      const before=(await client.query(`SELECT preferences.registration_status,account.email_verified_at FROM courier_service_preferences preferences
        JOIN courier_profiles p ON p.id=preferences.courier_profile_id JOIN users account ON account.id=p.user_id
        WHERE preferences.courier_profile_id=$1 FOR UPDATE OF preferences`,[id])).rows[0];
      if(!before) throw notFound();if(!before.email_verified_at) throw conflict('O entregador ainda precisa verificar o e-mail.');
      await client.query(`UPDATE courier_service_preferences SET registration_status=$2,availability_status='OFFLINE',
        latitude=NULL,longitude=NULL,accuracy=NULL,location_authorized_at=NULL,location_expires_at=NULL,updated_at=now() WHERE courier_profile_id=$1`,[id,input.status]);
      await client.query(`UPDATE courier_profiles SET status=$2 WHERE id=$1`,[id,input.status==='APPROVED'?'ACTIVE':'BLOCKED']);
      await client.query(`INSERT INTO platform_audit_logs(actor_platform_admin_id,action,entity_type,entity_id,before_data,after_data,reason)
        VALUES($1,'courier.registration_reviewed','courier_profile',$2,$3::jsonb,$4::jsonb,$5)`,
      [request.platformAuth.userId,id,JSON.stringify({status:before.registration_status}),JSON.stringify({status:input.status}),input.reason]);
      return {status:input.status};
    });
  });
}
