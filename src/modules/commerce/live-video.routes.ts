import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withRuntimeTransaction, type Database } from '../../database/pool.js';
import { authenticate,requireRoles } from '../auth/auth.guard.js';
import { AppError } from '../../shared/errors.js';
import { createIvsProvider, type IvsProvider } from '../../integrations/ivs/ivs.provider.js';
import { createLiveVideoService,parseViewerResult,videoLeaseHash } from './live-video.service.js';

const params=z.object({storeId:z.uuid(),id:z.uuid()});
const lease=z.object({leaseToken:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export async function liveVideoRoutes(app:FastifyInstance,db:Database,env:AppEnv,injected?:IvsProvider){
  const provider=injected??createIvsProvider(env),service=createLiveVideoService(db,env,provider);
  const manager=[authenticate(env,db),requireRoles('TENANT_MANAGER')];
  app.get('/commerce/stores/:storeId/lives/:id/studio',{preHandler:manager},(req,reply)=>{
    reply.header('Cache-Control','no-store');const {storeId,id}=params.parse(req.params);return service.status(req.auth,storeId,id);
  });
  for(const action of ['connect','heartbeat','disconnect'] as const)app.post(`/commerce/stores/:storeId/lives/:id/studio/${action}`,
    {preHandler:manager,config:{rateLimit:{max:30,timeWindow:'1 minute'}}},(req,reply)=>{
      reply.header('Cache-Control','no-store');const {storeId,id}=params.parse(req.params);
      if(action==='disconnect'){z.object({}).strict().parse(req.body);return service.disconnect(req.auth,storeId,id);}
      const input=lease.parse(req.body);return service[action](req.auth,storeId,id,input.leaseToken);
    });
  for(const action of ['join','renew','leave'] as const)app.post(`/public/lives/:publicToken/video/${action}`,{config:{rateLimit:{max:action==='join'?240:600,timeWindow:'1 minute'}}},async(req,reply)=>{
    reply.header('Cache-Control','no-store');
    if(!env.IVS_ENABLED)throw new AppError(503,'IVS_NOT_CONFIGURED','O vídeo ainda não foi habilitado.');
    const {publicToken}=z.object({publicToken:z.string().regex(/^[a-f0-9]{64}$/)}).parse(req.params),input=lease.parse(req.body);
    return withRuntimeTransaction(db,async c=>{
      if(action==='leave'){await c.query('SELECT commerce_live_viewer_leave($1,$2)',[publicToken,videoLeaseHash(input.leaseToken)]);return {released:true};}
      const data=parseViewerResult((await c.query<{data:Record<string,string>|null}>('SELECT commerce_live_viewer($1,$2,$3) AS data',[publicToken,videoLeaseHash(input.leaseToken),action==='renew'])).rows[0]?.data??null);
      if(action==='renew')return {deadlineAt:data.deadlineAt};
      return {deadlineAt:data.deadlineAt,playbackUrl:await provider.playback({arn:data.channelArn!,playbackUrl:data.playbackUrl!,ingestEndpoint:''},data.id!,new Date(data.deadlineAt!))};
    });
  });
}
