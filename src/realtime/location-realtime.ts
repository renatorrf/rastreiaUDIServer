import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';
import pg from 'pg';
import type { AppEnv } from '../config/env.js';
import { withRuntimeTransaction, withPlatformTransaction, type Database } from '../database/pool.js';
import type { RedisRuntime } from '../infrastructure/redis/redis-runtime.js';
import { verifyAccessToken, verifyPlatformAccessToken } from '../modules/auth/token.service.js';
import { assertIdentity, withIdentity } from '../modules/auth/identity.service.js';
import { scopedUnits } from '../modules/organization/operations.service.js';
import type { LocationStateStore } from '../modules/locations/location-state.store.js';
import type { LocationPublisher, LocationUpdate } from '../modules/locations/location.types.js';
import { resolvePublicTrackingSocket } from '../modules/tracking/tracking.service.js';
import type { DriverEventPublisher, DriverEventUpdate } from '../modules/driver-events/driver-event.types.js';

const storeRoom = (storeId: string) => `store:${storeId}`;
const trackingRoom = (deliveryId: string) => `tracking-delivery:${deliveryId}`;

async function consolidatedStores(database:Database,env:AppEnv,token:string,kind:string):Promise<string[]> {
  if(kind==='master') {
    const auth=await verifyPlatformAccessToken(env,token);
    return withPlatformTransaction(database,auth,async client=>{
      const active=await client.query("SELECT 1 FROM platform_admins WHERE id=$1 AND status='ACTIVE'",[auth.userId]);
      if(!active.rowCount)throw new Error('inactive master');return (await scopedUnits(client)).map(unit=>unit.id);
    });
  }
  if(kind!=='identity')throw new Error('invalid audience');
  const identity=await assertIdentity(database,env,`Bearer ${token}`);
  return withIdentity(database,identity.userId,async client=>(await scopedUnits(client,identity.userId))
    .filter(unit=>unit.role==='TENANT_MANAGER'||unit.role==='STORE_OPERATOR').map(unit=>unit.id));
}

class SocketLocationPublisher implements LocationPublisher, DriverEventPublisher {
  constructor(
    private readonly io: Server,
    private readonly database: Database,
    private readonly env: AppEnv,
    private readonly state: LocationStateStore,
  ) {}

  async publishEvent(update:DriverEventUpdate):Promise<void> {
    const event=update.event;
    const sockets=await this.io.of('/operations').in([storeRoom(event.storeId),`courier-user:${event.createdBy}`]).fetchSockets();
    for(const socket of sockets) {
      try {
        const auth=await verifyAccessToken(this.env,socket.data['accessToken'] as string);
        if(auth.tenantId!==event.tenantId||!auth.storeIds.includes(event.storeId)
          ||(auth.role==='COURIER'&&auth.userId!==event.createdBy))throw new Error('scope mismatch');
        const current=await withRuntimeTransaction(this.database,async client=>(await client.query<{allowed:boolean}>(
          'SELECT rastreia.tenant_session_is_current($1,$2,$3,$4) AS allowed',[auth.tenantId,auth.userId,auth.role,auth.storeIds])).rows[0]?.allowed);
        if(!current)throw new Error('revoked scope');
        socket.emit(`driver-event:${update.action}`,event);
      }catch{socket.disconnect(true);}
    }
    const managers=await this.io.of('/consolidated-operations').in(storeRoom(event.storeId)).fetchSockets();
    for(const socket of managers) {
      try {
        const allowed=await consolidatedStores(this.database,this.env,socket.data['accessToken'] as string,socket.data['kind'] as string);
        if(!allowed.includes(event.storeId))throw new Error('revoked scope');
        socket.emit('operation:changed',{storeId:event.storeId});
      }catch{socket.disconnect(true);}
    }
    // Only invalidation, never internal fields, goes to public subscribers.
    if(event.customerVisibility==='INTERNAL')return;
    for(const deliveryId of update.deliveryIds) {
      const subscribers=await this.io.of('/tracking').in(trackingRoom(deliveryId)).fetchSockets();
      for(const socket of subscribers) {
        try {
          const scope=await resolvePublicTrackingSocket(this.database,this.env,socket.data['trackingToken'] as string);
          if(scope.deliveryId!==deliveryId||scope.tenantId!==event.tenantId)throw new Error('scope mismatch');
          socket.emit('tracking:changed');
        }catch{socket.disconnect(true);}
      }
    }
  }

  async publish(update: LocationUpdate): Promise<void> {
    await this.state.put(update);
    const internalPayload = {
      deliveryId: update.deliveryId,
      courierId: update.courierId,
      storeId: update.storeId,
      latitude: update.latitude,
      longitude: update.longitude,
      accuracy: update.accuracy,
      speed: update.speed,
      heading: update.heading,
      capturedAt: update.capturedAt,
      stale: false,
    };
    // Revalidate before every publication: a room joined before revocation is
    // not an authorization cache. Remote sockets are included by the adapter.
    const sockets=await this.io.of('/operations').in(storeRoom(update.storeId)).fetchSockets();
    for(const socket of sockets) {
      try {
        const token=socket.data['accessToken'] as string;
        const auth=await verifyAccessToken(this.env,token);
        if(auth.tenantId!==update.tenantId||!auth.storeIds.includes(update.storeId))throw new Error('scope mismatch');
        const current=await withRuntimeTransaction(this.database,async client=>(await client.query<{allowed:boolean}>(
          'SELECT rastreia.tenant_session_is_current($1,$2,$3,$4) AS allowed',[auth.tenantId,auth.userId,auth.role,auth.storeIds])).rows[0]?.allowed);
        if(!current)throw new Error('revoked scope');
        socket.emit('location:update',internalPayload);
      } catch { socket.disconnect(true); }
    }

    if (!update.publicVisible) return;
    const publicPayload = {
      latitude: update.latitude,
      longitude: update.longitude,
      accuracy: update.accuracy,
      heading: update.heading,
      capturedAt: update.capturedAt,
      stale: false,
    };
    const subscribers=await this.io.of('/tracking').in(trackingRoom(update.deliveryId)).fetchSockets();
    for (const socket of subscribers) {
      try {
        // Resolve each subscriber under its own token RLS context; an anonymous
        // tenant-wide query must never enumerate all tracking tokens.
        const scope=await resolvePublicTrackingSocket(this.database,this.env,socket.data['trackingToken'] as string);
        if(scope.deliveryId!==update.deliveryId||scope.tenantId!==update.tenantId)throw new Error('scope mismatch');
        socket.emit('location:update',publicPayload);
      } catch { socket.disconnect(true); }
    }
  }
}

export async function createLocationRealtime(
  server: HttpServer,
  database: Database,
  env: AppEnv,
  allowedOrigins: string[],
  redis: RedisRuntime,
  state: LocationStateStore,
): Promise<{
  publisher: LocationPublisher & DriverEventPublisher;
  status: () => 'redis' | 'local';
  close: () => Promise<void>;
}> {
  const io = new Server(server, {
    cors: { origin: allowedOrigins, credentials: true },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 100_000,
  });

  const [pubClient, subClient] = await Promise.all([redis.duplicate(), redis.duplicate()]);
  if (pubClient && subClient) {
    io.adapter(createAdapter(pubClient, subClient, {
      key: redis.key('socket.io'),
      publishOnSpecificResponseChannel: true,
    }));
  } else {
    pubClient?.destroy();
    subClient?.destroy();
  }

  const operations = io.of('/operations');
  operations.use(async (socket, next) => {
    try {
      const accessToken = socket.handshake.auth['accessToken'];
      if (typeof accessToken !== 'string') throw new Error('missing token');
      const auth = await verifyAccessToken(env, accessToken);
      const current=await withRuntimeTransaction(database,async client=>(await client.query<{allowed:boolean}>(
        'SELECT rastreia.tenant_session_is_current($1,$2,$3,$4) AS allowed',[auth.tenantId,auth.userId,auth.role,auth.storeIds])).rows[0]?.allowed);
      if(!current)throw new Error('unauthorized scope');
      socket.data['auth'] = auth;
      socket.data['accessToken'] = accessToken;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  operations.on('connection', (socket) => {
    const auth = socket.data['auth'] as Awaited<ReturnType<typeof verifyAccessToken>>;
    if (auth.role === 'TENANT_MANAGER' || auth.role === 'STORE_OPERATOR') {
      for (const storeId of auth.storeIds) void socket.join(storeRoom(storeId));
    } else if(auth.role==='COURIER') {
      void socket.join(`courier-user:${auth.userId}`);
    }
  });

  const tracking = io.of('/tracking');
  const consolidated=io.of('/consolidated-operations');
  consolidated.use(async(socket,next)=>{
    try{
      const {accessToken,kind}=socket.handshake.auth;
      if(typeof accessToken!=='string'||typeof kind!=='string')throw new Error('missing token');
      const stores=await consolidatedStores(database,env,accessToken,kind);
      if(!stores.length&&kind!=='master')throw new Error('no scope');
      socket.data['accessToken']=accessToken;socket.data['kind']=kind;socket.data['stores']=stores;next();
    }catch{next(new Error('unauthorized'));}
  });
  consolidated.on('connection',socket=>{for(const id of socket.data['stores'] as string[])void socket.join(storeRoom(id));});
  tracking.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth['token'];
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid token');
      socket.data['scope'] = await resolvePublicTrackingSocket(database, env, token);
      socket.data['trackingToken'] = token;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  tracking.on('connection', (socket) => {
    const scope = socket.data['scope'] as { deliveryId: string };
    void socket.join(trackingRoom(scope.deliveryId));
  });

  // One lightweight invalidation on the existing sockets; no order/PII in the payload.
  // Each API replica listens locally, avoiding duplicate Redis broadcasts.
  let listener: pg.Client | undefined;
  if (env.IFOOD_ENABLED) {
    listener = new pg.Client({ connectionString: env.DATABASE_URL, application_name:'rastreia-integration-realtime',
      ssl:env.NODE_ENV==='production'?{rejectUnauthorized:true}:undefined });
    listener.on('error',()=>{ /* UI has a periodic refresh fallback if LISTEN disconnects. */ });
    listener.on('notification',message=>{
      if(message.channel!=='rastreia_operation_changed'||!message.payload)return;
      void (async()=>{
        const payload=JSON.parse(message.payload!) as {storeId:string;tenantId:string};
        for(const socket of operations.sockets.values()){
          try{
            const auth=await verifyAccessToken(env,socket.data['accessToken'] as string);
            if(!auth.storeIds.includes(payload.storeId)||auth.tenantId!==payload.tenantId)continue;
            const current=await withRuntimeTransaction(database,async client=>(await client.query<{ok:boolean}>(
              'SELECT tenant_session_is_current($1,$2,$3,$4) AS ok',[auth.tenantId,auth.userId,auth.role,auth.storeIds])).rows[0]?.ok);
            if(current)socket.emit('operation:changed',{storeId:payload.storeId});else socket.disconnect(true);
          }catch{socket.disconnect(true);}
        }
        for(const socket of consolidated.sockets.values()){
          try{if((await consolidatedStores(database,env,socket.data['accessToken'] as string,socket.data['kind'] as string)).includes(payload.storeId))socket.emit('operation:changed',{storeId:payload.storeId});}
          catch{socket.disconnect(true);}
        }
      })().catch(()=>{});
    });
    await listener.connect();await listener.query('LISTEN rastreia_operation_changed');
  }

  return {
    publisher: new SocketLocationPublisher(io, database, env, state),
    status: () => pubClient?.isReady && subClient?.isReady ? 'redis' : 'local',
    close: async () => {
      await listener?.end();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      pubClient?.destroy();
      subClient?.destroy();
    },
  };
}
