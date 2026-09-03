import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import {
  setTenantContext, withRuntimeTransaction, withTenantTransaction,
} from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { AppError, notFound, unauthorized } from '../../shared/errors.js';
import type { AuthContext } from '../auth/auth.types.js';
import type { LocationPointInput, LocationPublisher, LocationUpdate } from './location.types.js';
import {
  backgroundTrackingTokenHash, generateBackgroundTrackingToken, nativeLocationEventId,
} from './background-tracking-token.js';
import { processLocationPoints } from './location.service.js';

const activeLocationStatuses = ['COLLECTED', 'IN_ROUTE', 'NEXT_STOP'];

interface NativeLocationInput {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude?: number | null | undefined;
  bearing?: number | null | undefined;
  speed?: number | null | undefined;
  time: number;
}

interface BackgroundSessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  courier_profile_id: string;
  delivery_id: string;
}

async function activeCourierProfile(client: PoolClient, auth: AuthContext): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT profile.id
     FROM courier_profiles profile
     JOIN tenant_users membership ON membership.user_id = profile.user_id
     WHERE membership.tenant_id = $1 AND membership.user_id = $2
       AND membership.role = 'COURIER' AND membership.status = 'ACTIVE'
       AND profile.status = 'ACTIVE'
     FOR UPDATE OF profile`,
    [auth.tenantId, auth.userId],
  );
  if (!result.rows[0]) throw notFound('Perfil de entregador ativo não encontrado.');
  return result.rows[0].id;
}

export async function createBackgroundTrackingSession(
  database: Database,
  env: AppEnv,
  auth: AuthContext,
  deliveryId: string,
  platform: 'android' | 'ios',
  ip?: string,
) {
  const token = generateBackgroundTrackingToken();
  const tokenHash = backgroundTrackingTokenHash(token, env.TRACKING_TOKEN_PEPPER);
  return withTenantTransaction(database, auth, async (client) => {
    const courierId = await activeCourierProfile(client, auth);
    const delivery = await client.query<{ status: string; ends_at: Date }>(
      `SELECT delivery.status,day.ends_at FROM deliveries delivery
       JOIN courier_workdays day ON day.store_id=delivery.store_id AND day.courier_profile_id=delivery.courier_profile_id
         AND day.tenant_id=delivery.tenant_id AND day.status='CHECKED_IN' AND day.ends_at>now()
       WHERE delivery.id=$1 AND delivery.tenant_id=$2 AND delivery.courier_profile_id=$3
       FOR UPDATE OF delivery`,
      [deliveryId, auth.tenantId, courierId],
    );
    if (!delivery.rows[0] || !activeLocationStatuses.includes(delivery.rows[0].status)) {
      throw new AppError(422, 'LOCATION_NOT_AUTHORIZED', 'A entrega não está em um estado que permita rastreamento.');
    }

    await client.query(
      `UPDATE background_tracking_sessions
       SET revoked_at = now()
       WHERE tenant_id = $1 AND courier_profile_id = $2 AND revoked_at IS NULL`,
      [auth.tenantId, courierId],
    );
    const created = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO background_tracking_sessions
         (tenant_id, user_id, courier_profile_id, delivery_id, token_hash, platform, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, LEAST($8::timestamptz,now() + ($7::text || ' seconds')::interval))
       RETURNING id, expires_at`,
      [auth.tenantId, auth.userId, courierId, deliveryId, tokenHash, platform,
        env.BACKGROUND_TRACKING_SESSION_TTL_SECONDS,delivery.rows[0].ends_at],
    );
    const session = created.rows[0]!;
    await writeAudit(client, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'background_tracking.started',
      entityType: 'background_tracking_session',
      entityId: session.id,
      afterData: { deliveryId, platform, expiresAt: session.expires_at },
      ...(ip ? { ip } : {}),
    });
    return { id: session.id, token, deliveryId, platform, expiresAt: session.expires_at };
  });
}

export async function revokeBackgroundTrackingSession(
  database: Database,
  auth: AuthContext,
  sessionId: string,
  ip?: string,
) {
  return withTenantTransaction(database, auth, async (client) => {
    const revoked = await client.query<{ delivery_id: string }>(
      `UPDATE background_tracking_sessions
       SET revoked_at = now()
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND revoked_at IS NULL
       RETURNING delivery_id`,
      [sessionId, auth.tenantId, auth.userId],
    );
    if (revoked.rows[0]) {
      await writeAudit(client, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'background_tracking.stopped',
        entityType: 'background_tracking_session',
        entityId: sessionId,
        beforeData: { deliveryId: revoked.rows[0].delivery_id, active: true },
        afterData: { active: false },
        ...(ip ? { ip } : {}),
      });
    }
    return { revoked: Boolean(revoked.rows[0]) };
  });
}

function trackingHash(token: string, env: AppEnv): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized('Sessão de rastreamento inválida.');
  return backgroundTrackingTokenHash(token, env.TRACKING_TOKEN_PEPPER);
}

export async function ingestBackgroundLocation(
  database: Database,
  publisher: LocationPublisher,
  env: AppEnv,
  token: string,
  nativePoint: NativeLocationInput,
) {
  const hash = trackingHash(token, env);
  const updates: LocationUpdate[] = [];
  const response = await withRuntimeTransaction(database, async (client) => {
    await client.query("SELECT set_config('app.background_tracking_hash', $1, true)", [hash]);
    const lookup = await client.query<BackgroundSessionRow>(
      `SELECT id, tenant_id, user_id, courier_profile_id, delivery_id
       FROM background_tracking_sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       LIMIT 1`,
      [hash],
    );
    const session = lookup.rows[0];
    if (!session) throw unauthorized('Sessão de rastreamento inválida.');

    await setTenantContext(client, { tenantId: session.tenant_id, userId: session.user_id });
    const authorized = await client.query(
      `SELECT 1
       FROM courier_profiles profile
       JOIN tenant_users membership ON membership.user_id = profile.user_id
       JOIN deliveries delivery ON delivery.courier_profile_id = profile.id
       WHERE profile.id = $1 AND profile.user_id = $2 AND profile.status = 'ACTIVE'
         AND membership.tenant_id = $3 AND membership.role = 'COURIER' AND membership.status = 'ACTIVE'
         AND delivery.id = $4 AND delivery.tenant_id = $3
         AND delivery.status IN ('COLLECTED', 'IN_ROUTE', 'NEXT_STOP')`,
      [session.courier_profile_id, session.user_id, session.tenant_id, session.delivery_id],
    );
    if (!authorized.rowCount) {
      throw new AppError(422, 'LOCATION_NOT_AUTHORIZED', 'A operação de rastreamento não está mais ativa.');
    }

    const point: LocationPointInput = {
      eventId: nativeLocationEventId(session.id, nativePoint),
      deliveryId: session.delivery_id,
      latitude: nativePoint.latitude,
      longitude: nativePoint.longitude,
      accuracy: nativePoint.accuracy,
      speed: nativePoint.speed !== null && nativePoint.speed !== undefined && nativePoint.speed >= 0
        ? nativePoint.speed : null,
      heading: nativePoint.bearing !== null && nativePoint.bearing !== undefined && nativePoint.bearing >= 0
        ? nativePoint.bearing : null,
      altitude: nativePoint.altitude ?? null,
      capturedAt: new Date(Math.trunc(nativePoint.time)),
    };
    const auth: AuthContext = {
      userId: session.user_id,
      tenantId: session.tenant_id,
      role: 'COURIER',
      storeIds: [],
      sessionId: session.id,
    };
    const processed = await processLocationPoints(client, auth, [point]);
    updates.push(...processed.updates);
    await client.query(
      'UPDATE background_tracking_sessions SET last_seen_at = now() WHERE id = $1',
      [session.id],
    );
    const item = processed.results[0]!;
    if (!item.accepted) {
      throw new AppError(422, item.code ?? 'LOCATION_REJECTED', item.message ?? 'Localização rejeitada.');
    }
    return {
      accepted: true,
      eventId: item.eventId,
      duplicate: item.duplicate ?? false,
      sampled: item.sampled ?? false,
    };
  });
  for (const update of updates) await publisher.publish(update);
  return response;
}
