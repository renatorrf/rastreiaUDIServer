import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';
import type { AppEnv } from '../config/env.js';
import { withRuntimeTransaction, type Database } from '../database/pool.js';
import type { RedisRuntime } from '../infrastructure/redis/redis-runtime.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import type { LocationStateStore } from '../modules/locations/location-state.store.js';
import type { LocationPublisher, LocationUpdate } from '../modules/locations/location.types.js';
import { resolvePublicTrackingSocket } from '../modules/tracking/tracking.service.js';

const storeRoom = (storeId: string) => `store:${storeId}`;
const trackingRoom = (deliveryId: string) => `tracking-delivery:${deliveryId}`;

class SocketLocationPublisher implements LocationPublisher {
  constructor(
    private readonly io: Server,
    private readonly database: Database,
    private readonly env: AppEnv,
    private readonly state: LocationStateStore,
  ) {}

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
  publisher: LocationPublisher;
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
      if(!current||!['TENANT_MANAGER','STORE_OPERATOR'].includes(auth.role))throw new Error('unauthorized scope');
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
    }
  });

  const tracking = io.of('/tracking');
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

  return {
    publisher: new SocketLocationPublisher(io, database, env, state),
    status: () => pubClient?.isReady && subClient?.isReady ? 'redis' : 'local',
    close: async () => {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      pubClient?.destroy();
      subClient?.destroy();
    },
  };
}
