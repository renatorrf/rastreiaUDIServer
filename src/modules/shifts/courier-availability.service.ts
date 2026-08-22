import type { Database } from '../../database/pool.js';
import { withTenantTransaction } from '../../database/pool.js';
import { forbidden } from '../../shared/errors.js';
import type { AuthContext } from '../auth/auth.types.js';

export interface AvailabilityInput {
  available: boolean; latitude?: number | undefined; longitude?: number | undefined;
  accuracy?: number | undefined; interestRadiusM: number; availableUntil?: Date | null | undefined;
}

async function courierId(client: import('pg').PoolClient, auth: AuthContext): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM courier_profiles WHERE user_id = $1 AND status = 'ACTIVE'`, [auth.userId],
  );
  if (!result.rows[0]) throw forbidden('Seu perfil de entregador não está ativo.');
  return result.rows[0].id;
}

export async function getCourierAvailability(database: Database, auth: AuthContext) {
  return withTenantTransaction(database, auth, async (client) => {
    const id = await courierId(client, auth);
    const result = await client.query(
      `SELECT status = 'AVAILABLE' AS available, latitude, longitude, accuracy,
              interest_radius_m AS "interestRadiusM", available_until AS "availableUntil", updated_at AS "updatedAt"
       FROM courier_availability WHERE courier_profile_id = $1`, [id],
    );
    return result.rows[0] ?? { available: false, latitude: null, longitude: null, accuracy: null,
      interestRadiusM: 5000, availableUntil: null, updatedAt: null };
  });
}

export async function setCourierAvailability(database: Database, auth: AuthContext, input: AvailabilityInput) {
  return withTenantTransaction(database, auth, async (client) => {
    const id = await courierId(client, auth);
    if (input.available && (input.latitude === undefined || input.longitude === undefined || input.accuracy === undefined)) {
      throw forbidden('Informe a localização para ficar disponível.');
    }
    const result = await client.query(
      `INSERT INTO courier_availability
         (tenant_id, courier_profile_id, status, latitude, longitude, accuracy, interest_radius_m, available_until, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, courier_profile_id) DO UPDATE SET
         status = EXCLUDED.status, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
         accuracy = EXCLUDED.accuracy, interest_radius_m = EXCLUDED.interest_radius_m,
         available_until = EXCLUDED.available_until, updated_by = EXCLUDED.updated_by
       RETURNING status = 'AVAILABLE' AS available, latitude, longitude, accuracy,
         interest_radius_m AS "interestRadiusM", available_until AS "availableUntil", updated_at AS "updatedAt"`,
      [auth.tenantId, id, input.available ? 'AVAILABLE' : 'UNAVAILABLE', input.latitude ?? null,
        input.longitude ?? null, input.accuracy ?? null, input.interestRadiusM,
        input.availableUntil ?? null, auth.userId],
    );
    return result.rows[0];
  });
}
