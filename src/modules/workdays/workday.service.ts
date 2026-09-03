import type { PoolClient } from 'pg';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction, withTransaction } from '../../database/pool.js';
import type { AuthContext } from '../auth/auth.types.js';
import { conflict, notFound } from '../../shared/errors.js';
import { withIdempotency } from '../../shared/idempotency.js';
import { writeAudit } from '../../shared/audit.js';
import { materializeWorkdaysSql, workdaySelect } from './working-hours.js';

export interface Workday {
  id: string; storeId: string; storeName: string; courierId: string; userId: string;
  serviceDate: string; startsAt: Date; endsAt: Date; timezone: string;
  status: 'PENDING' | 'CONFIRMED' | 'DECLINED' | 'CHECKED_IN' | 'COMPLETED' | 'EXPIRED';
  checkinAt: Date | null; checkoutAt: Date | null; version: number;
}

export async function loadOwnWorkday(client: PoolClient, auth: AuthContext, id: string, lock = false): Promise<Workday> {
  const row = (await client.query<Workday>(`${workdaySelect}
    WHERE day.id=$1 AND day.tenant_id=$2 AND profile.user_id=$3
      AND profile.status='ACTIVE' AND EXISTS(SELECT 1 FROM courier_store_links link
        WHERE link.store_id=day.store_id AND link.courier_profile_id=profile.id AND link.status='ACTIVE')
    ${lock ? 'FOR UPDATE OF day' : ''}`, [id, auth.tenantId, auth.userId])).rows[0];
  if (!row) throw notFound('Jornada não encontrada para seu vínculo com esta loja.');
  return row;
}

export function assertCheckinWindow(day: Workday, now = new Date()): void {
  if (now.getTime() < new Date(day.startsAt).getTime() - 2 * 60 * 60_000) throw conflict('O check-in abre duas horas antes do início da loja.');
  if (now >= new Date(day.endsAt)) throw conflict('As atividades desta jornada já encerraram.');
  if (!['PENDING', 'CONFIRMED', 'DECLINED', 'CHECKED_IN'].includes(day.status)) throw conflict('Esta jornada já foi encerrada.');
}

export async function requireCourierCheckin(client: PoolClient, auth: AuthContext, storeId: string): Promise<void> {
  if (auth.role !== 'COURIER') return;
  const result = await client.query(`SELECT day.id FROM courier_workdays day
    JOIN courier_profiles profile ON profile.id=day.courier_profile_id
    WHERE day.tenant_id=$1 AND day.store_id=$2 AND profile.user_id=$3 AND day.status='CHECKED_IN'
      AND day.ends_at>now() AND day.location_consent_at IS NOT NULL`, [auth.tenantId, storeId, auth.userId]);
  if (!result.rowCount) throw conflict('Faça check-in em Loja de hoje antes de iniciar as entregas.');
}

export async function getMyWorkdays(database: Database, auth: AuthContext) {
  return withTenantTransaction(database, auth, async client => {
    await client.query(materializeWorkdaysSql, [auth.userId]);
    // Reconcile visible days even if a worker tick was delayed.
    await client.query(`UPDATE courier_workdays SET status=CASE WHEN status='CHECKED_IN' THEN 'COMPLETED' ELSE 'EXPIRED' END,
      checkout_at=CASE WHEN status='CHECKED_IN' THEN ends_at ELSE checkout_at END,latitude=NULL,longitude=NULL,accuracy=NULL,
      speed=NULL,heading=NULL,captured_at=NULL,updated_at=now(),version=version+1 WHERE tenant_id=$1 AND ends_at<=now()
        AND status IN ('PENDING','CONFIRMED','DECLINED','CHECKED_IN')
        AND courier_profile_id IN (SELECT id FROM courier_profiles WHERE user_id=$2)`,[auth.tenantId,auth.userId]);
    const data = (await client.query<Workday>(`${workdaySelect} WHERE day.tenant_id=$1 AND profile.user_id=$2
      AND (day.service_date=(now() AT TIME ZONE tenant.timezone)::date OR day.ends_at>now())
      AND day.starts_at<now()+interval '48 hours' ORDER BY (day.status='CHECKED_IN') DESC,day.starts_at,day.id`,
    [auth.tenantId, auth.userId])).rows;
    const active = data.find(day => day.status === 'CHECKED_IN' && new Date(day.endsAt) > new Date()) ?? null;
    const statistics = (await client.query<{ total: number; completed: number; pending: number }>(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE d.status='DELIVERED')::int AS completed,
      count(*) FILTER(WHERE d.status IN ('ASSIGNED','AWAITING_PICKUP','COLLECTED','IN_ROUTE','NEXT_STOP','RETURN_STARTED'))::int AS pending
      FROM deliveries d JOIN courier_profiles p ON p.id=d.courier_profile_id JOIN tenants t ON t.id=d.tenant_id
      WHERE d.tenant_id=$1 AND p.user_id=$2
        AND (d.created_at AT TIME ZONE t.timezone)::date=(now() AT TIME ZONE t.timezone)::date`, [auth.tenantId, auth.userId])).rows[0];
    return { data, active, statistics, serverTime: new Date().toISOString() };
  });
}

export async function respondWorkday(database: Database, auth: AuthContext, id: string, key: string,
  action: 'confirm' | 'decline' | 'check-in' | 'check-out', consent: boolean, ip?: string) {
  try {
    return await withTenantTransaction(database, auth, client => withIdempotency(client, auth, key,
      `workday.${action}:${id}`, { consent }, async () => {
        // Global profile lock plus unique index serialize simultaneous check-ins on two units.
        await client.query('SELECT id FROM courier_profiles WHERE user_id=$1 FOR UPDATE', [auth.userId]);
        const day = await loadOwnWorkday(client, auth, id, true);
        const before = day.status;
        if (action === 'check-in') {
          assertCheckinWindow(day);
          if (!consent) throw conflict('Confirme o compartilhamento de localização durante a jornada.');
          if (day.status !== 'CHECKED_IN') {
            await client.query(`UPDATE courier_workdays SET status='CHECKED_IN',confirmed_at=COALESCE(confirmed_at,now()),
              checkin_at=now(),location_consent_at=now(),version=version+1,updated_at=now() WHERE id=$1`, [id]);
          }
        } else if (action === 'check-out') {
          if (day.status !== 'CHECKED_IN') throw conflict('Não há check-in ativo nesta jornada.');
          const deliveries = await client.query(`SELECT id FROM deliveries WHERE tenant_id=$1 AND courier_profile_id=$2
            AND status IN ('COLLECTED','IN_ROUTE','NEXT_STOP','RETURN_STARTED') LIMIT 1`, [auth.tenantId, day.courierId]);
          if (deliveries.rowCount) throw conflict('Conclua ou transfira as entregas em andamento antes do check-out.');
          await client.query(`UPDATE courier_workdays SET status='COMPLETED',checkout_at=now(),latitude=NULL,longitude=NULL,
            accuracy=NULL,speed=NULL,heading=NULL,captured_at=NULL,version=version+1,updated_at=now() WHERE id=$1`, [id]);
          await client.query('UPDATE courier_workday_tracking_sessions SET revoked_at=now() WHERE workday_id=$1 AND revoked_at IS NULL', [id]);
          await client.query('UPDATE background_tracking_sessions SET revoked_at=now() WHERE tenant_id=$1 AND courier_profile_id=$2 AND revoked_at IS NULL',[auth.tenantId,day.courierId]);
        } else {
          if (!['PENDING','CONFIRMED','DECLINED'].includes(day.status) || new Date(day.endsAt) <= new Date()) throw conflict('A confirmação desta jornada já encerrou.');
          await client.query(`UPDATE courier_workdays SET status=$2,confirmed_at=now(),version=version+1,updated_at=now() WHERE id=$1`,
            [id, action === 'confirm' ? 'CONFIRMED' : 'DECLINED']);
        }
        const updated = await loadOwnWorkday(client, auth, id);
        await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId, action: `workday.${action}`,
          entityType: 'courier_workday', entityId: id, beforeData: { status: before }, afterData: { status: updated.status, consent }, ...(ip ? { ip } : {}) });
        return { statusCode: 200, body: updated };
      }));
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw conflict('Você já possui check-in em outra loja. Faça check-out antes de trocar.');
    throw error;
  }
}

export async function maintainWorkdays(database: Database, pushConfigured: boolean) {
  return withTransaction(database, async client => {
    await client.query(materializeWorkdaysSql, [null]);
    // Always end authorization at the scheduled end; no infinite background permission.
    await client.query(`UPDATE courier_workdays SET status=CASE WHEN status='CHECKED_IN' THEN 'COMPLETED' ELSE 'EXPIRED' END,
      checkout_at=CASE WHEN status='CHECKED_IN' THEN ends_at ELSE checkout_at END,
      latitude=NULL,longitude=NULL,accuracy=NULL,speed=NULL,heading=NULL,captured_at=NULL,updated_at=now(),version=version+1
      WHERE ends_at<=now() AND status IN ('PENDING','CONFIRMED','DECLINED','CHECKED_IN')`);
    await client.query(`UPDATE courier_workday_tracking_sessions SET revoked_at=now() WHERE revoked_at IS NULL
      AND (expires_at<=now() OR EXISTS(SELECT 1 FROM courier_workdays d WHERE d.id=workday_id AND d.status<>'CHECKED_IN'))`);
    await client.query("DELETE FROM courier_workday_points WHERE captured_at<now()-interval '7 days'");
    if (!pushConfigured) return { reminded: 0 };
    const due = (await client.query<{ id: string; tenant_id: string; starts_at: Date }>(`SELECT day.id,day.tenant_id,day.starts_at
      FROM courier_workdays day JOIN stores store ON store.id=day.store_id
      JOIN tenants tenant ON tenant.id=day.tenant_id
      WHERE day.status='PENDING' AND day.reminder_queued_at IS NULL
        AND day.starts_at-interval '2 hours'<=now() AND day.starts_at>now()
        AND store.status='ACTIVE' AND tenant.status='ACTIVE'
        AND EXISTS(SELECT 1 FROM courier_store_links link WHERE link.store_id=day.store_id
          AND link.courier_profile_id=day.courier_profile_id AND link.status='ACTIVE')
      ORDER BY day.starts_at,day.id FOR UPDATE OF day SKIP LOCKED LIMIT 100`)).rows;
    for (const day of due) {
      await client.query(`INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload)
        VALUES($1,'courier_workday',$2,'workday.confirmation.requested',$3::jsonb)`,
      [day.tenant_id, day.id, JSON.stringify({ startsAt: day.starts_at })]);
      await client.query('UPDATE courier_workdays SET reminder_queued_at=now() WHERE id=$1', [day.id]);
    }
    return { reminded: due.length };
  });
}
