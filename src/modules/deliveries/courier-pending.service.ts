import { withTenantTransaction, type Database } from '../../database/pool.js';
import { forbidden } from '../../shared/errors.js';
import type { AuthContext } from '../auth/auth.types.js';

/** Counts work, not unread notifications: one route regardless of its number of orders. */
export async function getCourierPendingSummary(database: Database, auth: AuthContext) {
  if (auth.role !== 'COURIER') throw forbidden();
  return withTenantTransaction(database, auth, async client => {
    const result = await client.query<{ deliveries: number; routes: number }>(`
      SELECT
        (SELECT count(*)::int FROM deliveries d
         JOIN courier_profiles c ON c.id=d.courier_profile_id
         WHERE d.tenant_id=$1 AND c.user_id=$2 AND d.store_id=ANY($3::uuid[])
           AND d.route_id IS NULL
           AND d.status IN ('ASSIGNED','AWAITING_PICKUP','COLLECTED','IN_ROUTE','NEXT_STOP')) AS deliveries,
        (SELECT count(*)::int FROM routes r
         JOIN courier_profiles c ON c.id=r.courier_profile_id
         WHERE r.tenant_id=$1 AND c.user_id=$2 AND r.store_id=ANY($3::uuid[])
           AND r.status IN ('DRAFT','ACTIVE')
           AND EXISTS (SELECT 1 FROM route_stops s WHERE s.route_id=r.id AND s.status='PENDING')) AS routes
    `, [auth.tenantId, auth.userId, auth.storeIds]);
    return result.rows[0]!;
  });
}
