import type { PoolClient } from 'pg';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction } from '../../database/pool.js';
import { AppError, notFound } from '../../shared/errors.js';
import { withIdempotency } from '../../shared/idempotency.js';
import type { AuthContext } from '../auth/auth.types.js';
import type { DeliveryStatus } from '../deliveries/delivery.types.js';
import type {
  LocationPointInput, LocationPublisher, LocationReference, LocationUpdate,
} from './location.types.js';
import type { LocationStateStore } from './location-state.store.js';
import { shouldSampleLocation, validateLocationPoint } from './location-validation.js';

interface DeliveryScope {
  id: string;
  storeId: string;
  status: DeliveryStatus;
}

interface ProcessResult {
  eventId: string;
  accepted: boolean;
  duplicate?: boolean;
  sampled?: boolean;
  code?: string;
  message?: string;
}

interface StoredLocation extends LocationReference {
  deliveryId: string;
}

const activeLocationStatuses: DeliveryStatus[] = ['COLLECTED', 'IN_ROUTE', 'NEXT_STOP'];
const publicLocationStatuses: DeliveryStatus[] = ['IN_ROUTE', 'NEXT_STOP'];

async function courierProfile(client: PoolClient, auth: AuthContext): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT profile.id
     FROM courier_profiles profile
     JOIN tenant_users membership ON membership.user_id = profile.user_id
     WHERE membership.tenant_id = $1 AND membership.user_id = $2
       AND membership.role = 'COURIER' AND membership.status = 'ACTIVE'
       AND profile.status = 'ACTIVE'`,
    [auth.tenantId, auth.userId],
  );
  const profile = result.rows[0];
  if (!profile) throw notFound('Perfil de entregador ativo não encontrado.');
  return profile.id;
}

async function deliveryScope(
  client: PoolClient,
  auth: AuthContext,
  courierId: string,
  deliveryId: string,
): Promise<DeliveryScope> {
  const result = await client.query<{ id: string; store_id: string; status: DeliveryStatus }>(
    `SELECT id, store_id, status
     FROM deliveries
     WHERE id = $1 AND tenant_id = $2 AND courier_profile_id = $3`,
    [deliveryId, auth.tenantId, courierId],
  );
  const delivery = result.rows[0];
  if (!delivery || !activeLocationStatuses.includes(delivery.status)) {
    throw new AppError(422, 'LOCATION_NOT_AUTHORIZED', 'A entrega não está em um estado que permita localização.');
  }
  return { id: delivery.id, storeId: delivery.store_id, status: delivery.status };
}

async function lastLocation(client: PoolClient, auth: AuthContext, courierId: string): Promise<StoredLocation | undefined> {
  const result = await client.query<{
    delivery_id: string; latitude: number; longitude: number; accuracy: number; captured_at: Date;
  }>(
    `SELECT delivery_id, latitude, longitude, accuracy, captured_at
     FROM courier_last_locations
     WHERE tenant_id = $1 AND courier_profile_id = $2
     FOR UPDATE`,
    [auth.tenantId, courierId],
  );
  const row = result.rows[0];
  return row ? {
    deliveryId: row.delivery_id, latitude: row.latitude, longitude: row.longitude,
    accuracy: row.accuracy, capturedAt: row.captured_at,
  } : undefined;
}

async function lastSample(client: PoolClient, auth: AuthContext, courierId: string): Promise<LocationReference | undefined> {
  const result = await client.query<LocationReference>(
    `SELECT latitude, longitude, accuracy, captured_at AS "capturedAt"
     FROM location_points
     WHERE tenant_id = $1 AND courier_profile_id = $2
     ORDER BY captured_at DESC LIMIT 1`,
    [auth.tenantId, courierId],
  );
  return result.rows[0];
}

export async function processLocationPoints(
  client: PoolClient,
  auth: AuthContext,
  points: LocationPointInput[],
): Promise<{ results: ProcessResult[]; updates: LocationUpdate[] }> {
  const courierId = await courierProfile(client, auth);
  let previous = await lastLocation(client, auth, courierId);
  let sampledPrevious = await lastSample(client, auth, courierId);
  const deliveryCache = new Map<string, DeliveryScope>();
  const results: ProcessResult[] = [];
  const updates: LocationUpdate[] = [];

  for (const point of [...points].sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime())) {
    const existingReceipt = await client.query(
      `SELECT 1 FROM location_event_receipts
       WHERE tenant_id = $1 AND courier_profile_id = $2 AND client_event_id = $3`,
      [auth.tenantId, courierId, point.eventId],
    );
    if (existingReceipt.rowCount) {
      results.push({ eventId: point.eventId, accepted: true, duplicate: true, sampled: false });
      continue;
    }
    const rejection = validateLocationPoint(point, previous);
    if (rejection) {
      results.push({ eventId: point.eventId, accepted: false, ...rejection });
      continue;
    }

    let delivery = deliveryCache.get(point.deliveryId);
    if (!delivery) {
      try {
        delivery = await deliveryScope(client, auth, courierId, point.deliveryId);
        deliveryCache.set(point.deliveryId, delivery);
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 422) {
          results.push({ eventId: point.eventId, accepted: false, code: error.code, message: error.message });
          continue;
        }
        throw error;
      }
    }

    const receipt = await client.query(
      `INSERT INTO location_event_receipts
         (tenant_id, courier_profile_id, delivery_id, client_event_id, captured_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, courier_profile_id, client_event_id) DO NOTHING
       RETURNING id`,
      [auth.tenantId, courierId, delivery.id, point.eventId, point.capturedAt],
    );
    if (!receipt.rowCount) {
      results.push({ eventId: point.eventId, accepted: true, duplicate: true, sampled: false });
      continue;
    }

    const sampled = shouldSampleLocation(point, sampledPrevious);
    await client.query(
      `INSERT INTO courier_last_locations
         (tenant_id, courier_profile_id, delivery_id, store_id, latitude, longitude,
          accuracy, speed, heading, altitude, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, courier_profile_id) DO UPDATE SET
         delivery_id = EXCLUDED.delivery_id, store_id = EXCLUDED.store_id,
         latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
         accuracy = EXCLUDED.accuracy, speed = EXCLUDED.speed,
         heading = EXCLUDED.heading, altitude = EXCLUDED.altitude,
         captured_at = EXCLUDED.captured_at, received_at = now(), updated_at = now()
       WHERE EXCLUDED.captured_at > courier_last_locations.captured_at`,
      [auth.tenantId, courierId, delivery.id, delivery.storeId, point.latitude, point.longitude,
        point.accuracy, point.speed ?? null, point.heading ?? null, point.altitude ?? null, point.capturedAt],
    );
    if (sampled) {
      await client.query(
        `INSERT INTO location_points
           (tenant_id, courier_profile_id, delivery_id, store_id, client_event_id,
            latitude, longitude, accuracy, speed, heading, altitude, captured_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [auth.tenantId, courierId, delivery.id, delivery.storeId, point.eventId,
          point.latitude, point.longitude, point.accuracy, point.speed ?? null,
          point.heading ?? null, point.altitude ?? null, point.capturedAt],
      );
      sampledPrevious = point;
    }
    previous = { ...point, deliveryId: delivery.id };
    results.push({ eventId: point.eventId, accepted: true, duplicate: false, sampled });
    updates.push({
      tenantId: auth.tenantId, storeId: delivery.storeId, deliveryId: delivery.id, courierId,
      latitude: point.latitude, longitude: point.longitude, accuracy: point.accuracy,
      speed: point.speed ?? null, heading: point.heading ?? null, capturedAt: point.capturedAt,
      publicVisible: publicLocationStatuses.includes(delivery.status),
    });
  }
  return { results, updates };
}

export async function ingestLocations(
  database: Database,
  publisher: LocationPublisher,
  auth: AuthContext,
  idempotencyKey: string,
  points: LocationPointInput[],
  operation: 'single' | 'batch',
) {
  const publishAfterCommit: LocationUpdate[] = [];
  const result = await withTenantTransaction(database, auth, async (client) =>
    withIdempotency(client, auth, idempotencyKey, `location.${operation}`, points, async () => {
      const processed = await processLocationPoints(client, auth, points);
      publishAfterCommit.push(...processed.updates);
      if (operation === 'single' && !processed.results[0]?.accepted) {
        const rejected = processed.results[0]!;
        throw new AppError(422, rejected.code ?? 'LOCATION_REJECTED', rejected.message ?? 'Localização rejeitada.');
      }
      return {
        statusCode: operation === 'single' ? 202 : 200,
        body: {
          accepted: processed.results.filter((item) => item.accepted).length,
          rejected: processed.results.filter((item) => !item.accepted).length,
          results: processed.results,
        },
      };
    }),
  );
  if (!result.replayed) {
    for (const update of publishAfterCommit) await publisher.publish(update);
  }
  return result;
}

interface ActiveLocationRow {
  courierId: string;
  courierName: string;
  deliveryId: string;
  deliveryReference: string | null;
  storeId: string;
  storeName: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  speed: number | null;
  heading: number | null;
  capturedAt: Date;
  stale: boolean;
}

export async function listActiveLocations(
  database: Database,
  auth: AuthContext,
  state: LocationStateStore,
) {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query<ActiveLocationRow>(
      `SELECT location.courier_profile_id AS "courierId", courier_user.name AS "courierName",
              location.delivery_id AS "deliveryId", delivery.external_reference AS "deliveryReference",
              location.store_id AS "storeId", store.name AS "storeName",
              location.latitude, location.longitude, location.accuracy, location.speed,
              location.heading, location.captured_at AS "capturedAt",
              location.captured_at < now() - interval '2 minutes' AS stale
       FROM courier_last_locations location
       JOIN deliveries delivery ON delivery.id = location.delivery_id
       JOIN stores store ON store.id = location.store_id
       JOIN courier_profiles courier ON courier.id = location.courier_profile_id
       JOIN users courier_user ON courier_user.id = courier.user_id
       WHERE delivery.status IN ('COLLECTED', 'IN_ROUTE', 'NEXT_STOP')
         AND (
           $1::text = 'TENANT_MANAGER'
           OR ($1::text = 'STORE_OPERATOR' AND location.store_id = ANY($2::uuid[]))
           OR ($1::text = 'COURIER' AND courier.user_id = $3)
         )
       ORDER BY location.captured_at DESC`,
      [auth.role, auth.storeIds, auth.userId],
    );
    const cached = await state.getCouriers(auth.tenantId, result.rows.map((row) => row.courierId));
    const data = result.rows.map((row) => {
      const live = cached.get(row.courierId);
      if (!live || live.deliveryId !== row.deliveryId || live.capturedAt <= row.capturedAt) {
        return { ...row, online: live?.online ?? false };
      }
      return {
        ...row,
        latitude: live.latitude,
        longitude: live.longitude,
        accuracy: live.accuracy,
        speed: live.speed,
        heading: live.heading,
        capturedAt: live.capturedAt,
        stale: live.capturedAt.getTime() < Date.now() - 120_000,
        online: live.online,
      };
    });
    return { data };
  });
}
