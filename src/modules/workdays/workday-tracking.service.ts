import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import { setTenantContext, withRuntimeTransaction, withTenantTransaction, type Database } from '../../database/pool.js';
import { AppError, unauthorized } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type { AuthContext } from '../auth/auth.types.js';
import { backgroundTrackingTokenHash, generateBackgroundTrackingToken, nativeLocationEventId } from '../locations/background-tracking-token.js';
import { validateLocationPoint } from '../locations/location-validation.js';
import { processLocationPoints } from '../locations/location.service.js';
import type { LocationPointInput, LocationPublisher, LocationReference, LocationUpdate } from '../locations/location.types.js';
import { loadOwnWorkday } from './workday.service.js';

export type WorkdayPoint = Omit<LocationPointInput, 'deliveryId'>;
export interface NativeWorkdayPoint {
  latitude: number; longitude: number; accuracy: number; time: number;
  speed?: number | null | undefined; bearing?: number | null | undefined; altitude?: number | null | undefined;
}

async function activeDay(client: PoolClient, auth: AuthContext, id: string) {
  const day = await loadOwnWorkday(client, auth, id, true);
  const membership = await client.query(`SELECT 1 FROM users u JOIN tenant_users m ON m.user_id=u.id
    WHERE u.id=$1 AND u.status='ACTIVE' AND m.tenant_id=$2 AND m.status='ACTIVE' AND m.role='COURIER'`, [auth.userId, auth.tenantId]);
  if (!membership.rowCount || day.status !== 'CHECKED_IN' || !day.checkinAt || new Date(day.endsAt) <= new Date()) {
    throw new AppError(422, 'WORKDAY_NOT_ACTIVE', 'O check-in não está mais ativo. A localização foi interrompida.');
  }
  return day;
}

export async function createWorkdayTrackingSession(database: Database, env: AppEnv, auth: AuthContext, id: string, platform: 'android' | 'ios') {
  return withTenantTransaction(database, auth, async client => {
    const day = await activeDay(client, auth, id);
    const token = generateBackgroundTrackingToken();
    await client.query('UPDATE courier_workday_tracking_sessions SET revoked_at=now() WHERE workday_id=$1 AND revoked_at IS NULL', [id]);
    const session = (await client.query<{ id: string; expiresAt: Date }>(`INSERT INTO courier_workday_tracking_sessions
      (tenant_id,workday_id,user_id,token_hash,platform,expires_at) VALUES($1,$2,$3,$4,$5,LEAST($6::timestamptz,now()+($7::text||' seconds')::interval))
      RETURNING id,expires_at AS "expiresAt"`, [auth.tenantId,id,auth.userId,backgroundTrackingTokenHash(token,env.TRACKING_TOKEN_PEPPER),platform,day.endsAt,env.BACKGROUND_TRACKING_SESSION_TTL_SECONDS])).rows[0]!;
    await writeAudit(client,{tenantId:auth.tenantId,actorUserId:auth.userId,action:'workday.tracking.started',entityType:'courier_workday',entityId:id,afterData:{sessionId:session.id,platform,expiresAt:session.expiresAt}});
    return { ...session, workdayId: id, token, platform };
  });
}

export async function revokeWorkdayTrackingSession(database: Database, auth: AuthContext, id: string) {
  return withTenantTransaction(database,auth,async client => {
    await client.query('UPDATE courier_workday_tracking_sessions SET revoked_at=now() WHERE id=$1 AND tenant_id=$2 AND user_id=$3', [id,auth.tenantId,auth.userId]);
    return { revoked: true };
  });
}

async function processPoints(client: PoolClient, auth: AuthContext, id: string, points: WorkdayPoint[]) {
  const day = await activeDay(client,auth,id);
  const stored = (await client.query<LocationReference>(`SELECT latitude,longitude,accuracy,captured_at AS "capturedAt"
    FROM courier_workdays WHERE id=$1 AND captured_at IS NOT NULL`,[id])).rows[0];
  let previous = stored;
  const results: Array<{ eventId: string; accepted: boolean; duplicate?: boolean; code?: string; message?: string }> = [];
  const updates: LocationUpdate[] = [];
  for (const point of [...points].sort((a,b) => a.capturedAt.getTime()-b.capturedAt.getTime())) {
    const duplicate = await client.query('SELECT 1 FROM courier_workday_points WHERE workday_id=$1 AND event_id=$2',[id,point.eventId]);
    if (duplicate.rowCount) { results.push({eventId:point.eventId,accepted:true,duplicate:true}); continue; }
    const rejection = validateLocationPoint(point,previous);
    if (rejection || point.capturedAt < new Date(day.checkinAt!) || point.capturedAt >= new Date(day.endsAt)) {
      results.push({eventId:point.eventId,accepted:false,...(rejection ?? {code:'OUTSIDE_WORKDAY',message:'Ponto fora da jornada autorizada.'})}); continue;
    }
    await client.query(`INSERT INTO courier_workday_points(tenant_id,workday_id,event_id,latitude,longitude,accuracy,captured_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[auth.tenantId,id,point.eventId,point.latitude,point.longitude,point.accuracy,point.capturedAt]);
    await client.query(`UPDATE courier_workdays SET latitude=$2,longitude=$3,accuracy=$4,speed=$5,heading=$6,captured_at=$7 WHERE id=$1`,
      [id,point.latitude,point.longitude,point.accuracy,point.speed ?? null,point.heading ?? null,point.capturedAt]);
    previous = point;
    // Never accept a client-supplied delivery id. Buffered points from an earlier
    // stage cannot be attached to the next customer's token after a stop changes.
    const delivery = (await client.query<{ id: string }>(`SELECT d.id FROM deliveries d
      WHERE d.tenant_id=$1 AND d.store_id=$2 AND d.courier_profile_id=$3
        AND (d.status='NEXT_STOP' OR (d.status='IN_ROUTE' AND d.route_id IS NULL))
        AND d.out_for_delivery_at<=$4 AND d.updated_at<=$4
      ORDER BY (d.status='NEXT_STOP') DESC,d.out_for_delivery_at DESC,d.id LIMIT 1 FOR UPDATE`,
    [auth.tenantId,day.storeId,day.courierId,point.capturedAt])).rows[0];
    if (delivery) {
      const processed = await processLocationPoints(client,auth,[{...point,deliveryId:delivery.id}]);
      updates.push(...processed.updates);
    }
    results.push({eventId:point.eventId,accepted:true});
  }
  return { results, updates };
}

export async function ingestWorkdayPoints(database: Database, publisher: LocationPublisher, auth: AuthContext, id: string, points: WorkdayPoint[]) {
  const processed = await withTenantTransaction(database,auth,client => processPoints(client,auth,id,points));
  for (const update of processed.updates) await publisher.publish(update);
  return { results: processed.results };
}

export async function ingestNativeWorkdayPoint(database: Database, publisher: LocationPublisher, env: AppEnv, token: string, point: NativeWorkdayPoint) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized('Sessão de rastreamento inválida.');
  const hash = backgroundTrackingTokenHash(token,env.TRACKING_TOKEN_PEPPER);
  const processed = await withRuntimeTransaction(database,async client => {
    await client.query("SELECT set_config('app.workday_tracking_hash',$1,true)",[hash]);
    const session = (await client.query<{id:string;tenant_id:string;user_id:string;workday_id:string}>(`SELECT id,tenant_id,user_id,workday_id
      FROM courier_workday_tracking_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`,[hash])).rows[0];
    if (!session) throw unauthorized('Sessão de rastreamento inválida ou expirada.');
    await setTenantContext(client,{tenantId:session.tenant_id,userId:session.user_id});
    const auth: AuthContext = {tenantId:session.tenant_id,userId:session.user_id,sessionId:session.id,role:'COURIER',storeIds:[]};
    const result = await processPoints(client,auth,session.workday_id,[{
      eventId:nativeLocationEventId(session.id,point),latitude:point.latitude,longitude:point.longitude,accuracy:point.accuracy,
      capturedAt:new Date(Math.trunc(point.time)),speed:point.speed != null && point.speed>=0 ? point.speed : null,
      heading:point.bearing != null && point.bearing>=0 ? point.bearing : null,altitude:point.altitude ?? null,
    }]);
    await client.query('UPDATE courier_workday_tracking_sessions SET last_seen_at=now() WHERE id=$1',[session.id]);
    return result;
  });
  for (const update of processed.updates) await publisher.publish(update);
  return { results: processed.results };
}
