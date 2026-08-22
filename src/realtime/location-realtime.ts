import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';
import type { AppEnv } from '../config/env.js';
import { setTenantContext, withRuntimeTransaction, type Database } from '../database/pool.js';
import type { RedisRuntime } from '../infrastructure/redis/redis-runtime.js';
import { assertActiveTenant } from '../modules/auth/auth.guard.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import type { LocationStateStore } from '../modules/locations/location-state.store.js';
import type { LocationPublisher, LocationUpdate } from '../modules/locations/location.types.js';
import { resolvePublicTrackingSocket } from '../modules/tracking/tracking.service.js';

const anonymousUserId = '00000000-0000-0000-0000-000000000000';
const tenantRoom = (tenantId: string) => `tenant:${tenantId}`;
const storeRoom = (storeId: string) => `store:${storeId}`;
const trackingRoom = (tokenId: string) => `tracking-token:${tokenId}`;

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
    this.io.of('/operations')
      .to(tenantRoom(update.tenantId))
      .to(storeRoom(update.storeId))
      .emit('location:update', internalPayload);

    if (!update.publicVisible) return;
    const tokenIds = await withRuntimeTransaction(this.database, async (client) => {
      await setTenantContext(client, { tenantId: update.tenantId, userId: anonymousUserId });
      const result = await client.query<{ id: string }>(
        `SELECT token.id
         FROM tracking_tokens token
         JOIN deliveries delivery ON delivery.id = token.delivery_id
         WHERE token.delivery_id = $1 AND token.revoked_at IS NULL AND token.expires_at > now()
           AND delivery.status IN ('IN_ROUTE', 'NEXT_STOP')
           AND (delivery.delivered_at IS NULL
                OR delivery.delivered_at + ($2::text || ' seconds')::interval > now())`,
        [update.deliveryId, this.env.TRACKING_COMPLETED_GRACE_SECONDS],
      );
      return result.rows.map((row) => row.id);
    });
    const publicPayload = {
      latitude: update.latitude,
      longitude: update.longitude,
      accuracy: update.accuracy,
      heading: update.heading,
      capturedAt: update.capturedAt,
      stale: false,
    };
    for (const tokenId of tokenIds) {
      this.io.of('/tracking').to(trackingRoom(tokenId)).emit('location:update', publicPayload);
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
      await assertActiveTenant(database, auth.tenantId);
      socket.data['auth'] = auth;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  operations.on('connection', (socket) => {
    const auth = socket.data['auth'] as Awaited<ReturnType<typeof verifyAccessToken>>;
    if (auth.role === 'TENANT_MANAGER') void socket.join(tenantRoom(auth.tenantId));
    if (auth.role === 'STORE_OPERATOR') {
      for (const storeId of auth.storeIds) void socket.join(storeRoom(storeId));
    }
  });

  const tracking = io.of('/tracking');
  tracking.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth['token'];
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid token');
      socket.data['scope'] = await resolvePublicTrackingSocket(database, env, token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  tracking.on('connection', (socket) => {
    const scope = socket.data['scope'] as { tokenId: string };
    void socket.join(trackingRoom(scope.tokenId));
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
