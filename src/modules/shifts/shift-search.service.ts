import type { PoolClient } from 'pg';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction, withTransaction } from '../../database/pool.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import type { AuthContext } from '../auth/auth.types.js';

interface SearchRow {
  id: string; tenant_id: string; position_id: string; slot_id: string; store_id: string;
  status: string; current_wave: number; initial_radius_m: number; radius_step_m: number;
  max_radius_m: number; wave_duration_seconds: number; expires_at: Date;
  position_status: string;
}

export interface StartSearchInput {
  initialRadiusM: number; radiusStepM: number; waveDurationSeconds: number;
}

function canUseStore(auth: AuthContext, storeId: string): boolean {
  return auth.role === 'TENANT_MANAGER' || (auth.role === 'STORE_OPERATOR' && auth.storeIds.includes(storeId));
}

async function ensureSearch(
  client: PoolClient,
  tenantId: string,
  positionId: string,
  actorUserId: string | null,
  input?: StartSearchInput,
  qualified = false,
): Promise<SearchRow> {
  const q = qualified ? 'rastreia.' : '';
  const positionResult = await client.query<{
    slot_id: string; store_id: string; position_status: string; search_radius_m: number; ends_at: Date;
  }>(
    `SELECT position.slot_id, slot.store_id, position.status AS position_status,
            slot.search_radius_m, slot.ends_at
     FROM ${q}shift_positions position JOIN ${q}shift_slots slot ON slot.id = position.slot_id
     WHERE position.id = $1 AND position.tenant_id = $2 FOR UPDATE OF position`, [positionId, tenantId],
  );
  const position = positionResult.rows[0];
  if (!position) throw notFound('Vaga não encontrada.');
  if (position.position_status !== 'AVAILABLE') throw conflict('A busca exige uma vaga disponível.');
  const initial = Math.min(input?.initialRadiusM ?? 2000, position.search_radius_m);
  const step = input?.radiusStepM ?? 2000;
  await client.query(
    `INSERT INTO ${q}shift_searches
       (tenant_id, position_id, initial_radius_m, radius_step_m, max_radius_m,
        wave_duration_seconds, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, position_id) DO NOTHING`,
    [tenantId, positionId, initial, step, position.search_radius_m,
      input?.waveDurationSeconds ?? 120, position.ends_at, actorUserId],
  );
  const result = await client.query<SearchRow>(
    `SELECT search.id, search.tenant_id, search.position_id, position.slot_id, slot.store_id,
            search.status, search.current_wave, search.initial_radius_m, search.radius_step_m,
            search.max_radius_m, search.wave_duration_seconds, search.expires_at,
            position.status AS position_status
     FROM ${q}shift_searches search
     JOIN ${q}shift_positions position ON position.id = search.position_id
     JOIN ${q}shift_slots slot ON slot.id = position.slot_id
     WHERE search.position_id = $1`, [positionId],
  );
  return result.rows[0]!;
}

async function openNextWave(client: PoolClient, search: SearchRow, qualified = false): Promise<boolean> {
  const q = qualified ? 'rastreia.' : '';
  const active = await client.query<{ id: string; closes_at: Date }>(
    `SELECT id, closes_at FROM ${q}shift_search_waves
     WHERE search_id = $1 AND status = 'ACTIVE' ORDER BY wave_number DESC LIMIT 1 FOR UPDATE`, [search.id],
  );
  if (active.rows[0] && active.rows[0].closes_at.getTime() > Date.now()) return false;
  if (active.rows[0]) {
    await client.query(
      `UPDATE ${q}shift_search_waves SET status = 'CLOSED', closed_at = now() WHERE id = $1`, [active.rows[0].id],
    );
    await client.query(
      `UPDATE ${q}shift_search_candidates SET status = 'EXPIRED', responded_at = now()
       WHERE wave_id = $1 AND status = 'NOTIFIED'`, [active.rows[0].id],
    );
  }
  const nextWave = search.current_wave + 1;
  const radius = search.current_wave === 0
    ? search.initial_radius_m
    : Math.min(search.max_radius_m, search.initial_radius_m + search.current_wave * search.radius_step_m);
  const priorRadius = search.current_wave === 0
    ? 0
    : Math.min(search.max_radius_m, search.initial_radius_m + (search.current_wave - 1) * search.radius_step_m);
  if (Date.now() >= search.expires_at.getTime() || (search.current_wave > 0 && priorRadius >= search.max_radius_m)) {
    await client.query(
      `UPDATE ${q}shift_searches SET status = 'EXHAUSTED', completed_at = now() WHERE id = $1`, [search.id],
    );
    return false;
  }
  const closesAt = new Date(Math.min(search.expires_at.getTime(), Date.now() + search.wave_duration_seconds * 1000));
  const wave = await client.query<{ id: string }>(
    `INSERT INTO ${q}shift_search_waves
       (tenant_id, search_id, wave_number, radius_m, closes_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [search.tenant_id, search.id, nextWave, radius, closesAt],
  );
  const waveId = wave.rows[0]!.id;
  const candidates = await client.query<{ id: string; courier_profile_id: string }>(
    `INSERT INTO ${q}shift_search_candidates
       (tenant_id, search_id, wave_id, courier_profile_id, distance_m)
     SELECT $1, $2, $3, eligible.courier_profile_id, eligible.distance_m
     FROM (
       SELECT profile.id AS courier_profile_id,
         6371000 * acos(LEAST(1.0, GREATEST(-1.0,
           sin(radians(availability.latitude)) * sin(radians(store.latitude)) +
           cos(radians(availability.latitude)) * cos(radians(store.latitude)) *
           cos(radians(availability.longitude - store.longitude))
         ))) AS distance_m,
         availability.interest_radius_m
       FROM ${q}shift_searches search
       JOIN ${q}shift_positions position ON position.id = search.position_id
       JOIN ${q}shift_slots slot ON slot.id = position.slot_id
       JOIN ${q}stores store ON store.id = slot.store_id
       JOIN ${q}courier_store_links link ON link.tenant_id = search.tenant_id
         AND link.store_id = slot.store_id AND link.status = 'ACTIVE'
       JOIN ${q}courier_profiles profile ON profile.id = link.courier_profile_id AND profile.status = 'ACTIVE'
       JOIN ${q}courier_availability availability ON availability.tenant_id = search.tenant_id
         AND availability.courier_profile_id = profile.id AND availability.status = 'AVAILABLE'
       WHERE search.id = $2 AND (availability.available_until IS NULL OR availability.available_until > now())
         AND availability.accuracy <= 100
         AND (slot.requirements->>'vehicleType' IS NULL OR slot.requirements->>'vehicleType' = profile.vehicle_type::text)
         AND NOT EXISTS (
           SELECT 1 FROM ${q}shift_positions occupied
           JOIN ${q}shift_slots occupied_slot ON occupied_slot.id = occupied.slot_id
           WHERE occupied.assigned_courier_id = profile.id AND occupied.status IN ('FILLED', 'ACTIVE')
             AND occupied_slot.starts_at < slot.ends_at AND occupied_slot.ends_at > slot.starts_at
         )
         AND NOT EXISTS (
           SELECT 1 FROM ${q}shift_search_candidates previous
           WHERE previous.search_id = search.id AND previous.courier_profile_id = profile.id
         )
     ) eligible
     WHERE eligible.distance_m <= LEAST($4, eligible.interest_radius_m)
     ON CONFLICT (tenant_id, search_id, courier_profile_id) DO NOTHING
     RETURNING id, courier_profile_id`,
    [search.tenant_id, search.id, waveId, radius],
  );
  await client.query(
    `UPDATE ${q}shift_search_waves SET candidate_count = $2 WHERE id = $1`, [waveId, candidates.rowCount],
  );
  await client.query(
    `UPDATE ${q}shift_searches SET current_wave = $2 WHERE id = $1`, [search.id, nextWave],
  );
  if (candidates.rowCount) await client.query(
    `INSERT INTO ${q}outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'shift_position', $2, 'shift.search.wave', $3::jsonb)`,
    [search.tenant_id, search.position_id, JSON.stringify({ waveId, waveNumber: nextWave, radiusM: radius })],
  );
  return true;
}

export async function startEmergencySearch(
  database: Database, auth: AuthContext, positionId: string, input: StartSearchInput,
): Promise<{ searchId: string; status: string }> {
  return withTenantTransaction(database, auth, async (client) => {
    const store = await client.query<{ store_id: string }>(
      `SELECT slot.store_id FROM shift_positions position JOIN shift_slots slot ON slot.id = position.slot_id
       WHERE position.id = $1`, [positionId],
    );
    if (!store.rows[0]) throw notFound('Vaga não encontrada.');
    if (!canUseStore(auth, store.rows[0].store_id)) throw forbidden('Você não administra esta loja.');
    await client.query(
      `UPDATE outbox_events SET processed_at = now(), last_error = 'SUPERSEDED_BY_WAVE_SEARCH'
       WHERE aggregate_id = $1 AND event_type = 'shift.available' AND processed_at IS NULL`, [positionId],
    );
    const search = await ensureSearch(client, auth.tenantId, positionId, auth.userId, input);
    await openNextWave(client, search);
    return { searchId: search.id, status: 'SEARCHING' };
  });
}

export async function advanceEmergencySearches(database: Database, limit = 50): Promise<{ advanced: number }> {
  return withTransaction(database, async (client) => {
    const result = await client.query<SearchRow>(
      `SELECT search.id, search.tenant_id, search.position_id, position.slot_id, slot.store_id,
              search.status, search.current_wave, search.initial_radius_m, search.radius_step_m,
              search.max_radius_m, search.wave_duration_seconds, search.expires_at,
              position.status AS position_status
       FROM rastreia.shift_searches search
       JOIN rastreia.shift_positions position ON position.id = search.position_id
       JOIN rastreia.shift_slots slot ON slot.id = position.slot_id
       WHERE search.status = 'SEARCHING'
       ORDER BY search.updated_at FOR UPDATE OF search SKIP LOCKED LIMIT $1`, [limit],
    );
    let advanced = 0;
    for (const search of result.rows) {
      if (search.position_status !== 'AVAILABLE') {
        await client.query(
          `UPDATE rastreia.shift_searches SET status = 'FILLED', completed_at = now()
           WHERE id = $1`, [search.id],
        );
        continue;
      }
      if (await openNextWave(client, search, true)) advanced += 1;
    }
    return { advanced };
  });
}

export async function ensureMissedCheckinSearch(
  client: PoolClient, position: { id: string; tenant_id: string },
): Promise<void> {
  await ensureSearch(client, position.tenant_id, position.id, null, undefined, true);
}
