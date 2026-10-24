import { beforeEach,describe,expect,it,vi } from 'vitest';
import { exportPKCS8,generateKeyPair,jwtVerify } from 'jose';
import type { AppEnv } from '../../config/env.js';
import { createIvsProvider,ivsChannels } from './ivs.provider.js';
const send=vi.hoisted(()=>vi.fn());
vi.mock('@aws-sdk/client-ivs',async original=>({...await original<typeof import('@aws-sdk/client-ivs')>(),IvsClient:class{send=send;}}));
const arn='arn:aws:ivs:us-east-1:123456789012:channel/demo',store='6fd867b2-36a1-4e08-b108-887894d85954';
const env={IVS_ENABLED:true,IVS_REGION:'us-east-1',IVS_CHANNELS_JSON:JSON.stringify({[store]:arn}),IVS_PLAYBACK_PRIVATE_KEY:'configured',APP_ORIGINS:'https://example.test'} as AppEnv;
describe('IVS provider: no real AWS requests',()=>{
  beforeEach(()=>{send.mockReset();});
  it('is opt-in and rejects sharing a channel across units or the wrong region',()=>{
    expect(ivsChannels({...env,IVS_ENABLED:false})).toEqual({});expect(ivsChannels(env)).toEqual({[store]:arn});
    expect(()=>ivsChannels({...env,IVS_REGION:'us-west-2'})).toThrow('Configuração IVS inválida');
    expect(()=>ivsChannels({...env,IVS_CHANNELS_JSON:JSON.stringify({[store]:arn,'327211c9-8fb4-4a8f-b5a7-8a774706b003':arn})})).toThrow();
  });
  it('refuses public/insecure channels before revealing a key',async()=>{
    send.mockResolvedValue({channel:{authorized:false}});
    await expect(createIvsProvider(env).channel(arn)).rejects.toMatchObject({code:'IVS_CHANNEL_CONFIGURATION'});
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('recovers a key from an uncertain previous create rather than creating another',async()=>{
    send.mockResolvedValueOnce({streamKeys:[{arn:'key-arn',tags:{'rastreia-live':'live'}}]}).mockResolvedValueOnce({streamKey:{value:'test-only-key'}});
    expect(await createIvsProvider(env).key(arn,'live')).toBe('test-only-key');
    expect(send.mock.calls.map(([command])=>command.constructor.name)).toEqual(['ListStreamKeysCommand','GetStreamKeyCommand']);
  });
  it('never deletes a foreign/manual key or stops its stream',async()=>{
    send.mockResolvedValue({streamKeys:[{arn:'external-key',tags:{}}]});
    await expect(createIvsProvider(env).stop(arn,'live')).rejects.toMatchObject({code:'IVS_CHANNEL_BUSY'});
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('revokes the stream key before stopping and tolerates an already offline channel',async()=>{
    send.mockResolvedValueOnce({streamKeys:[{arn:'key',tags:{'rastreia-live':'live'}}]}).mockResolvedValueOnce({}).mockRejectedValueOnce({name:'ChannelNotBroadcasting'});
    await createIvsProvider(env).stop(arn,'live');
    expect(send.mock.calls.map(([command])=>command.constructor.name)).toEqual(['ListStreamKeysCommand','DeleteStreamKeyCommand','StopStreamCommand']);
  });
  it('does not leak raw AWS errors',async()=>{
    send.mockRejectedValue(new Error('SECRET_PROVIDER_CONTENT'));
    await expect(createIvsProvider(env).channel(arn)).rejects.toMatchObject({code:'IVS_UNAVAILABLE'});
    const failure=await createIvsProvider(env).channel(arn).catch((error:unknown)=>error);
    expect((failure as Error).message).not.toContain('SECRET_PROVIDER_CONTENT');
  });
  it('signs ES384 single-use viewer tokens, bounded by the commercial deadline',async()=>{
    const {privateKey,publicKey}=await generateKeyPair('ES384',{extractable:true}),deadline=new Date(Date.now()+60000);
    const provider=createIvsProvider({...env,IVS_PLAYBACK_PRIVATE_KEY:await exportPKCS8(privateKey)});
    const url=await provider.playback({arn,ingestEndpoint:'ingest',playbackUrl:'https://demo.playback.live-video.net/video.m3u8'},'anonymous-viewer',deadline);
    const result=await jwtVerify(new URL(url).searchParams.get('token')!,publicKey);
    expect(result.protectedHeader.alg).toBe('ES384');expect(result.payload).toMatchObject({'aws:channel-arn':arn,'aws:viewer-id':'anonymous-viewer','aws:strict-origin-enforcement':true,'aws:access-control-allow-origin':'https://example.test'});
    expect(result.payload['aws:single-use-uuid']).toBeTruthy();expect(result.payload.exp).toBe(Math.floor(deadline.getTime()/1000));expect(send).not.toHaveBeenCalled();
  });
});
