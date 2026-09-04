import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../database/pool.js';
import type { AppEnv } from '../config/env.js';
import { RedisRuntime } from '../infrastructure/redis/redis-runtime.js';
import type { LocationStateStore } from '../modules/locations/location-state.store.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import { resolvePublicTrackingSocket } from '../modules/tracking/tracking.service.js';
import { createLocationRealtime } from './location-realtime.js';

vi.mock('../modules/auth/token.service.js',()=>({verifyAccessToken:vi.fn()}));
vi.mock('../modules/tracking/tracking.service.js',()=>({resolvePublicTrackingSocket:vi.fn()}));
const active=new Set<string>();
const clients:Socket[]=[];
let realtime:Awaited<ReturnType<typeof createLocationRealtime>>|undefined;
const update={tenantId:'tenant-a',storeId:'store-a',deliveryId:'delivery-a',courierId:'courier-a',latitude:-18.9,longitude:-48.2,
  eventId:'location-event-a',accuracy:10,speed:null,heading:null,capturedAt:new Date(),publicVisible:true};
async function setup(){
  const server=createServer();
  const database={connect:async()=>({query:async(sql:string,values:unknown[]=[])=>({rows:sql.includes('tenant_session_is_current')?[{allowed:active.has(String(values[1]))}]:[]}),release:()=>{}})} as unknown as Database;
  const state={put:async()=>true} as LocationStateStore;
  realtime=await createLocationRealtime(server,database,{} as AppEnv,[],new RedisRuntime(false,false,'test:',null),state);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function connect(url:string,namespace:string,auth:Record<string,string>){
  const client=io(url+namespace,{auth,transports:['websocket'],forceNew:true,reconnection:false});clients.push(client);
  await new Promise<void>((resolve,reject)=>{client.once('connect',resolve);client.once('connect_error',reject);});return client;
}
afterEach(async()=>{clients.splice(0).forEach(client=>client.disconnect());await realtime?.close();realtime=undefined;active.clear();vi.resetAllMocks();});
describe('location namespace isolation (local adapter, mocked authorization)',()=>{
  it('sends only to the selected unit and revalidates revoked access before publication',async()=>{
    vi.mocked(verifyAccessToken).mockImplementation(async(_env,token)=>({tenantId:'tenant-a',userId:token,storeIds:[token==='manager-a'?'store-a':'store-b'],role:'TENANT_MANAGER'} as Awaited<ReturnType<typeof verifyAccessToken>>));
    active.add('manager-a');active.add('manager-b');const url=await setup();
    const a=await connect(url,'/operations',{accessToken:'manager-a'}),b=await connect(url,'/operations',{accessToken:'manager-b'});
    const other=vi.fn();b.on('location:update',other);
    const received=new Promise<Record<string,unknown>>(resolve=>a.once('location:update',resolve));
    await realtime!.publisher.publish({...update,publicVisible:false});expect((await received)['storeId']).toBe('store-a');expect(other).not.toHaveBeenCalled();
    active.delete('manager-a');const disconnected=new Promise<void>(resolve=>a.once('disconnect',()=>resolve()));
    await realtime!.publisher.publish({...update,publicVisible:false});await disconnected;expect(a.connected).toBe(false);
  });
  it('publishes a minimal public payload and disconnects a token revoked after connection',async()=>{
    const token='a'.repeat(43),otherToken='b'.repeat(43);let revoked=false;
    vi.mocked(resolvePublicTrackingSocket).mockImplementation(async(_db,_env,value)=>{
      if(revoked&&value===token)throw new Error('revoked');return {tokenId:value,tenantId:'tenant-a',deliveryId:value===token?'delivery-a':'delivery-b'};});
    const url=await setup(),a=await connect(url,'/tracking',{token}),b=await connect(url,'/tracking',{token:otherToken});const other=vi.fn();b.on('location:update',other);
    const received=new Promise<Record<string,unknown>>(resolve=>a.once('location:update',resolve));await realtime!.publisher.publish(update);
    const payload=await received;expect(Object.keys(payload).sort()).toEqual([
      'accuracy','capturedAt','eventId','heading','latitude','longitude','occurredAt','stale','version',
    ]);expect(other).not.toHaveBeenCalled();
    revoked=true;const disconnected=new Promise<void>(resolve=>a.once('disconnect',()=>resolve()));await realtime!.publisher.publish(update);await disconnected;expect(a.connected).toBe(false);
  });
});
