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
      `SELECT status = 'AVAILABLE' AND updated_at>now()-interval '5 minutes'
              AND (available_until IS NULL OR available_until>now()) AS available, latitude, longitude, accuracy,
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
    const preference=await client.query<{registration_status:string}>('SELECT registration_status FROM courier_service_preferences WHERE courier_profile_id=$1',[id]);
    if(input.available&&preference.rows[0]&&preference.rows[0].registration_status!=='APPROVED')throw forbidden('Seu cadastro precisa estar aprovado.');
    if(input.available&&(input.accuracy??101)>100)throw forbidden('A precisão da localização deve ser de até 100 metros.');
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
      [auth.tenantId, id, input.available ? 'AVAILABLE' : 'UNAVAILABLE', input.available?input.latitude:null,
        input.available?input.longitude:null, input.available?input.accuracy:null, input.interestRadiusM,
        input.available?new Date(Math.min(input.availableUntil?.getTime()??Infinity,Date.now()+300000)):null, auth.userId],
    );
    await client.query(`UPDATE courier_service_preferences SET availability_status=$2,latitude=$3,longitude=$4,accuracy=$5,
      location_authorized_at=CASE WHEN $2='AVAILABLE' THEN now() ELSE NULL END,
      location_expires_at=CASE WHEN $2='AVAILABLE' THEN now()+interval '5 minutes' ELSE NULL END,updated_at=now()
      WHERE courier_profile_id=$1`,[id,input.available?'AVAILABLE':'OFFLINE',input.available?input.latitude:null,
        input.available?input.longitude:null,input.available?input.accuracy:null]);
    return result.rows[0];
  });
}
