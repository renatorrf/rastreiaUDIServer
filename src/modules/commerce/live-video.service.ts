import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import { withTenantTransaction, withTransaction, type Database } from '../../database/pool.js';
import type { AuthContext } from '../auth/auth.types.js';
import { AppError, conflict, notFound } from '../../shared/errors.js';
import { createIvsProvider, ivsChannels, type IvsProvider } from '../../integrations/ivs/ivs.provider.js';
import { lockLiveStore, liveDetail, expireLiveStore } from './live.service.js';
import { requireCommerceStore } from './commerce.service.js';

export const videoLeaseHash=(token:string)=>createHash('sha256').update(token).digest('hex');
const workerReady=async(c:PoolClient)=>!!(await c.query("SELECT id FROM commerce_live_video_worker WHERE seen_at>now()-interval '60 seconds'")).rowCount;
async function requireRunning(c:PoolClient,store:string,id:string){
  await lockLiveStore(c,store);
  const live=await liveDetail(c,store,id);
  if(live.status!=='LIVE'||!live.storePublished)throw conflict('A sessão precisa estar em andamento e com catálogo publicado.');
  if(!await workerReady(c))throw new AppError(503,'IVS_WORKER_OFFLINE','O monitor de vídeo está indisponível. Aguarde antes de transmitir.');
  return live;
}
export function createLiveVideoService(db:Database,env:AppEnv,injected?:IvsProvider){
  const channels=ivsChannels(env),provider=injected??createIvsProvider(env);
  const channelFor=(store:string)=>{const arn=channels[store];if(!arn)throw new AppError(503,'IVS_NOT_CONFIGURED','A transmissão Amazon IVS ainda não foi habilitada para esta unidade.');return arn;};
  return {
    async status(auth:AuthContext,store:string,id:string){
      return withTenantTransaction(db,auth,async c=>{
        await requireCommerceStore(c,store);await expireLiveStore(c,store);const session=await liveDetail(c,store,id);
        if(!channels[store])return {session,enabled:false,workerReady:false,video:null};
        const video=(await c.query(`SELECT state,shutdown_requested AS "shutdownRequested",provider_online AS "providerOnline",
          checked_at AS "checkedAt",lease_until AS "leaseUntil" FROM commerce_live_video WHERE live_id=$1`,[id])).rows[0]??null;
        return {session,enabled:true,workerReady:await workerReady(c),video};
      });
    },
    async connect(auth:AuthContext,store:string,id:string,token:string){
      let arn='';const hash=videoLeaseHash(token);
      // Commit the cleanup intent BEFORE any external operation. A crash after CreateStreamKey is recoverable by the worker.
      await withTenantTransaction(db,auth,async c=>{
        await requireCommerceStore(c,store);arn=channelFor(store);
        await requireRunning(c,store,id);
        const row=(await c.query('SELECT *,lease_until>now() AS valid FROM commerce_live_video WHERE live_id=$1 FOR UPDATE',[id])).rows[0];
        if(row&&row.state!=='STOPPED'&&(row.lease_hash!==hash||row.owner_id!==auth.userId||row.shutdown_requested||!row.valid))
          throw conflict('Outro estúdio está conectado ou o vídeo está encerrando. Feche a transmissão anterior e aguarde a liberação.');
        if(row&&row.channel_arn!==arn)throw conflict('O canal desta sessão foi alterado. Encerre a sessão e prepare uma nova.');
        await c.query(`INSERT INTO commerce_live_video(live_id,tenant_id,store_id,channel_arn,owner_id,lease_hash,lease_until)
          VALUES($1,$2,$3,$4,$5,$6,now()+interval '90 seconds') ON CONFLICT(live_id) DO UPDATE
          SET owner_id=excluded.owner_id,lease_hash=excluded.lease_hash,lease_until=excluded.lease_until,state='PREPARING',shutdown_requested=false,provider_online=false,checked_at=NULL,updated_at=now()`,
        [id,auth.tenantId,store,arn,auth.userId,hash]);
      });
      return withTenantTransaction(db,auth,async c=>{
        const session=await requireRunning(c,store,id);
        const row=(await c.query('SELECT * FROM commerce_live_video WHERE live_id=$1 FOR UPDATE',[id])).rows[0];
        if(!row||row.lease_hash!==hash||row.owner_id!==auth.userId||row.shutdown_requested||row.state==='STOPPED')throw conflict('O estúdio foi desconectado.');
        const channel=await provider.channel(arn),streamKey=await provider.key(arn,id);
        await c.query(`UPDATE commerce_live_video SET state='READY',ingest_endpoint=$2,playback_url=$3,lease_until=LEAST($4::timestamptz,now()+interval '90 seconds'),updated_at=now() WHERE live_id=$1`,[id,channel.ingestEndpoint,channel.playbackUrl,session.deadlineAt]);
        // Not persisted in idempotency responses, logs, audit, localStorage or sessionStorage.
        return {streamKey,ingestEndpoint:channel.ingestEndpoint,deadlineAt:session.deadlineAt};
      });
    },
    async heartbeat(auth:AuthContext,store:string,id:string,token:string){
      return withTenantTransaction(db,auth,async c=>{
        await requireCommerceStore(c,store);channelFor(store);
        const session=await requireRunning(c,store,id);
        const row=(await c.query('SELECT *,lease_until>now() AS valid FROM commerce_live_video WHERE live_id=$1 FOR UPDATE',[id])).rows[0];
        if(!row||row.state!=='READY'||row.shutdown_requested||!row.valid||row.lease_hash!==videoLeaseHash(token)||row.owner_id!==auth.userId)
          throw conflict('A autorização deste estúdio venceu. Pare a câmera e reconecte o vídeo.');
        const online=await provider.online(String(row.channel_arn));
        await c.query("UPDATE commerce_live_video SET provider_online=$2,checked_at=now(),lease_until=LEAST($3::timestamptz,now()+interval '90 seconds'),updated_at=now() WHERE live_id=$1",[id,online,session.deadlineAt]);
        return {providerOnline:online,deadlineAt:session.deadlineAt};
      });
    },
    async disconnect(auth:AuthContext,store:string,id:string){
      return withTenantTransaction(db,auth,async c=>{
        await requireCommerceStore(c,store);await liveDetail(c,store,id);
        if(channels[store])await c.query('UPDATE commerce_live_video SET shutdown_requested=true,provider_online=false,updated_at=now() WHERE live_id=$1',[id]);
        return {pending:true};
      });
    },
  };
}

/** Durable retries, serialized with studio operations; no dependency on delivery notification leases. */
export async function maintainLiveVideo(db:Database,env:AppEnv,injected?:IvsProvider){
  if(!env.IVS_ENABLED)return;
  ivsChannels(env);const provider=injected??createIvsProvider(env);
  const pending=(await db.query<{live_id:string;store_id:string}>(`SELECT v.live_id,v.store_id FROM rastreia.commerce_live_video v
    JOIN rastreia.commerce_live_sessions l ON l.id=v.live_id WHERE v.state<>'STOPPED' AND
    (v.shutdown_requested OR v.lease_until<=now() OR l.status<>'LIVE' OR l.deadline_at<=now()
    OR (rastreia.commerce_public_live(l.public_token)->>'status') IS DISTINCT FROM 'LIVE') LIMIT 50`)).rows;
  let failed=false;
  for(const row of pending)try{await withTransaction(db,async c=>{
    await c.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE',[row.store_id]);
    const v=(await c.query(`SELECT v.* FROM commerce_live_video v JOIN commerce_live_sessions l ON l.id=v.live_id
      WHERE v.live_id=$1 AND v.state<>'STOPPED' AND (v.shutdown_requested OR v.lease_until<=now() OR l.status<>'LIVE' OR l.deadline_at<=now()
      OR (commerce_public_live(l.public_token)->>'status') IS DISTINCT FROM 'LIVE') FOR UPDATE OF v`,[row.live_id])).rows[0];
    if(!v)return;
    await provider.stop(String(v.channel_arn),row.live_id);
    await c.query("UPDATE commerce_live_video SET state='STOPPED',provider_online=false,shutdown_requested=false,updated_at=now() WHERE live_id=$1",[row.live_id]);
  });}catch{failed=true;}
  const expired=(await db.query<{id:string;channel_arn:string}>(`SELECT a.id,v.channel_arn FROM rastreia.commerce_live_viewers a
    JOIN rastreia.commerce_live_video v ON v.live_id=a.live_id WHERE a.revoked_at IS NULL
    AND (a.lease_until<=now() OR v.state='STOPPED') LIMIT 100`)).rows;
  for(const row of expired)try{
    await provider.revoke(row.channel_arn,row.id);
    // IVS revocation is asynchronous. Keep the slot during the propagation window.
    await db.query("UPDATE rastreia.commerce_live_viewers SET revoked_at=now(),release_after=now()+interval '60 seconds' WHERE id=$1 AND revoked_at IS NULL",[row.id]);
  }catch{failed=true;}
  if(failed)throw new Error('IVS cleanup pending; failed operations will be retried.');
  await db.query('INSERT INTO rastreia.commerce_live_video_worker(id,seen_at) VALUES(true,now()) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at');
}

export function parseViewerResult(data:Record<string,string>|null){
  if(!data)throw notFound('O vídeo ainda não está disponível. Aguarde o início da transmissão.');
  if(data.error)throw new AppError(409,data.error,data.error==='LIVE_AUDIENCE_FULL'?'Esta live atingiu o limite de espectadores. Tente novamente em instantes.':'A conexão de vídeo expirou. Toque em reconectar.');
  return data;
}
