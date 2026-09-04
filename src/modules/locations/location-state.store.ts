import type { RedisRuntime } from '../../infrastructure/redis/redis-runtime.js';
import type { LocationUpdate } from './location.types.js';

export interface LocationStateSnapshot extends LocationUpdate {
  online: boolean;
}

export interface LocationStateStore {
  put(update: LocationUpdate): Promise<boolean>;
  getDelivery(tenantId: string, deliveryId: string): Promise<LocationStateSnapshot | null>;
  getCouriers(tenantId: string, courierIds: string[]): Promise<Map<string, LocationStateSnapshot>>;
}

interface SerializedLocationUpdate extends Omit<LocationUpdate, 'capturedAt'> {
  capturedAt: string;
}

function parseUpdate(value: string | null): LocationUpdate | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SerializedLocationUpdate>;
    if (typeof parsed.tenantId !== 'string' || typeof parsed.storeId !== 'string'
        || typeof parsed.deliveryId !== 'string' || typeof parsed.courierId !== 'string'
        || typeof parsed.latitude !== 'number' || typeof parsed.longitude !== 'number'
        || typeof parsed.accuracy !== 'number' || typeof parsed.capturedAt !== 'string') return null;
    const capturedAt = new Date(parsed.capturedAt);
    if (Number.isNaN(capturedAt.getTime())) return null;
    return {
      eventId: typeof parsed.eventId === 'string'
        ? parsed.eventId
        : `location:${parsed.deliveryId}:${capturedAt.getTime()}`,
      tenantId: parsed.tenantId,
      storeId: parsed.storeId,
      deliveryId: parsed.deliveryId,
      courierId: parsed.courierId,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      accuracy: parsed.accuracy,
      speed: typeof parsed.speed === 'number' ? parsed.speed : null,
      heading: typeof parsed.heading === 'number' ? parsed.heading : null,
      capturedAt,
      publicVisible: parsed.publicVisible === true,
    };
  } catch {
    return null;
  }
}

export class RedisLocationStateStore implements LocationStateStore {
  constructor(
    private readonly redis: RedisRuntime,
    private readonly locationTtlSeconds: number,
    private readonly presenceTtlSeconds: number,
  ) {}

  private courierKey(tenantId: string, courierId: string): string {
    return this.redis.key(`location:courier:${tenantId}:${courierId}`);
  }

  private deliveryKey(tenantId: string, deliveryId: string): string {
    return this.redis.key(`location:delivery:${tenantId}:${deliveryId}`);
  }

  private presenceKey(tenantId: string, courierId: string): string {
    return this.redis.key(`presence:courier:${tenantId}:${courierId}`);
  }

  async put(update: LocationUpdate): Promise<boolean> {
    const client = this.redis.client;
    if (!client) return false;
    const serialized: SerializedLocationUpdate = { ...update, capturedAt: update.capturedAt.toISOString() };
    try {
      await client.multi()
        .set(this.courierKey(update.tenantId, update.courierId), JSON.stringify(serialized), { EX: this.locationTtlSeconds })
        .set(this.deliveryKey(update.tenantId, update.deliveryId), JSON.stringify(serialized), { EX: this.locationTtlSeconds })
        .set(this.presenceKey(update.tenantId, update.courierId), update.capturedAt.toISOString(), { EX: this.presenceTtlSeconds })
        .exec();
      return true;
    } catch {
      return false;
    }
  }

  async getDelivery(tenantId: string, deliveryId: string): Promise<LocationStateSnapshot | null> {
    const client = this.redis.client;
    if (!client) return null;
    try {
      const update = parseUpdate(await client.get(this.deliveryKey(tenantId, deliveryId)));
      if (!update) return null;
      const online = await client.exists(this.presenceKey(tenantId, update.courierId)) > 0;
      return { ...update, online };
    } catch {
      return null;
    }
  }

  async getCouriers(tenantId: string, courierIds: string[]): Promise<Map<string, LocationStateSnapshot>> {
    const client = this.redis.client;
    const snapshots = new Map<string, LocationStateSnapshot>();
    if (!client || courierIds.length === 0) return snapshots;
    try {
      const locationKeys = courierIds.map((courierId) => this.courierKey(tenantId, courierId));
      const presenceKeys = courierIds.map((courierId) => this.presenceKey(tenantId, courierId));
      const [locations, presences] = await Promise.all([client.mGet(locationKeys), client.mGet(presenceKeys)]);
      for (const [index, courierId] of courierIds.entries()) {
        const update = parseUpdate(locations[index] ?? null);
        if (update) snapshots.set(courierId, { ...update, online: presences[index] !== null });
      }
      return snapshots;
    } catch {
      return snapshots;
    }
  }
}
