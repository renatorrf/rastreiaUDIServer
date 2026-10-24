import { randomUUID } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { IvsClient, GetChannelCommand, GetStreamCommand, ListStreamKeysCommand, GetStreamKeyCommand,
  CreateStreamKeyCommand, DeleteStreamKeyCommand, StopStreamCommand, StartViewerSessionRevocationCommand } from '@aws-sdk/client-ivs';
import type { AppEnv } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';

export interface IvsChannel { arn:string; ingestEndpoint:string; playbackUrl:string }
export interface IvsProvider {
  channel(arn:string):Promise<IvsChannel>;
  key(arn:string,liveId:string):Promise<string>;
  online(arn:string):Promise<boolean>;
  stop(arn:string,liveId:string):Promise<void>;
  revoke(arn:string,viewerId:string):Promise<void>;
  playback(channel:IvsChannel,viewerId:string,deadline:Date):Promise<string>;
}
export function playbackOrigins(env:AppEnv){
  const origins=(env.IVS_PLAYBACK_ORIGINS||env.APP_ORIGINS||'').split(',').map(v=>v.trim()).filter(Boolean);
  if(!origins.length||origins.length>5||origins.some(origin=>{try{const url=new URL(origin);return url.protocol!=='https:'||url.origin!==origin;}catch{return true;}}))
    throw new Error('Configure de uma a cinco origens HTTPS exatas para o playback IVS.');
  return origins.join(',');
}
export function ivsChannels(env:AppEnv):Record<string,string> {
  if(!env.IVS_ENABLED)return {};
  try {
    const channels=z.record(z.uuid(),z.string().regex(/^arn:aws:ivs:[a-z0-9-]+:\d{12}:channel\/[A-Za-z0-9-]+$/)).parse(JSON.parse(env.IVS_CHANNELS_JSON));
    const arns=Object.values(channels);
    if(!env.IVS_PLAYBACK_PRIVATE_KEY||new Set(arns).size!==arns.length||arns.some(a=>a.split(':')[3]!==env.IVS_REGION))throw new Error();
    playbackOrigins(env);
    return channels;
  }catch{throw new Error('Configuração IVS inválida: confira região, canais exclusivos por unidade e chave privada de playback.');}
}
const unavailable=()=>new AppError(503,'IVS_UNAVAILABLE','O serviço de vídeo não respondeu. Aguarde e tente novamente; a sessão comercial foi preservada.');
const absent=(e:unknown)=>['ResourceNotFoundException','ChannelNotBroadcasting'].includes((e as Error)?.name);
export function createIvsProvider(env:AppEnv):IvsProvider {
  const client=new IvsClient({region:env.IVS_REGION,maxAttempts:2});
  const options=()=>({abortSignal:AbortSignal.timeout(8000)});
  // Do not forward AWS errors: provider diagnostics can contain sensitive request context.
  const safe=async<T>(run:()=>Promise<T>)=>{try{return await run();}catch(e){if(e instanceof AppError)throw e;throw unavailable();}};
  const keys=async(arn:string)=>{
    const result=await client.send(new ListStreamKeysCommand({channelArn:arn,maxResults:50}),options());
    return result.streamKeys??[];
  };
  const provider:IvsProvider={
    channel:arn=>safe(async()=>{
      const {channel}=await client.send(new GetChannelCommand({arn}),options());
      if(!channel?.authorized||channel.insecureIngest||channel.latencyMode!=='LOW'||!channel.ingestEndpoint||!channel.playbackUrl)
        throw new AppError(503,'IVS_CHANNEL_CONFIGURATION','O canal deve ser privado, de baixa latência e com ingestão segura. Solicite a configuração à plataforma.');
      return {arn,ingestEndpoint:channel.ingestEndpoint,playbackUrl:channel.playbackUrl};
    }),
    key:(arn,liveId)=>safe(async()=>{
      const existing=await keys(arn);
      // Dedicated channels only. Never revoke a manually managed/foreign key as a side effect of a start.
      if(existing.some(k=>k.tags?.['rastreia-live']!==liveId))throw new AppError(409,'IVS_CHANNEL_BUSY','Canal com outra chave de transmissão. A plataforma deve liberar o canal antes de iniciar.');
      if(existing[0]?.arn){const r=await client.send(new GetStreamKeyCommand({arn:existing[0].arn}),options());if(r.streamKey?.value)return r.streamKey.value;}
      const result=await client.send(new CreateStreamKeyCommand({channelArn:arn,tags:{'rastreia-live':liveId}}),options());
      if(!result.streamKey?.value)throw unavailable();return result.streamKey.value;
    }),
    online:arn=>safe(async()=>{try{const r=await client.send(new GetStreamCommand({channelArn:arn}),options());return r.stream?.state==='LIVE';}catch(e){if(absent(e))return false;throw e;}}),
    stop:(arn,liveId)=>safe(async()=>{
      // Revoke BEFORE disconnecting: StopStream alone permits reconnection with the old key.
      const existing=await keys(arn);
      if(existing.some(k=>k.tags?.['rastreia-live']!==liveId))throw new AppError(409,'IVS_CHANNEL_BUSY','O canal contém uma chave externa e precisa de revisão da plataforma.');
      for(const key of existing)if(key.arn){
        try{await client.send(new DeleteStreamKeyCommand({arn:key.arn}),options());}catch(e){if(!absent(e))throw e;}
      }
      try{await client.send(new StopStreamCommand({channelArn:arn}),options());}catch(e){if(!absent(e))throw e;}
    }),
    revoke:(channelArn,viewerId)=>safe(async()=>{await client.send(new StartViewerSessionRevocationCommand({channelArn,viewerId}),options());}),
    playback:(channel,viewerId,deadline)=>safe(async()=>{
      const key=await importPKCS8(env.IVS_PLAYBACK_PRIVATE_KEY.replace(/\\n/g,'\n'),'ES384');
      const token=await new SignJWT({'aws:channel-arn':channel.arn,'aws:viewer-id':viewerId,'aws:single-use-uuid':randomUUID(),
        'aws:access-control-allow-origin':playbackOrigins(env),'aws:strict-origin-enforcement':true,'aws:maximum-resolution':'HD'})
        .setProtectedHeader({alg:'ES384',typ:'JWT'}).setExpirationTime(Math.min(Math.floor(Date.now()/1000)+120,Math.floor(deadline.getTime()/1000))).sign(key);
      return `${channel.playbackUrl}?token=${encodeURIComponent(token)}`;
    }),
  };
  return provider;
}
