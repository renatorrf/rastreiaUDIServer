import type { Database } from '../../database/pool.js';
import { withTenantTransaction } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { withIdempotency } from '../../shared/idempotency.js';
import type { AuthContext } from '../auth/auth.types.js';
import { requireCourierCheckin } from '../workdays/workday.service.js';

export type CustomerAlertAction = 'ARRIVED' | 'WAITING_AT_GATE';

export async function notifyDeliveryCustomer(database: Database, auth: AuthContext, id: string,
  key: string, action: CustomerAlertAction) {
  if (auth.role !== 'COURIER') throw forbidden('Somente o entregador pode avisar a chegada.');
  return withTenantTransaction(database, auth, async client => {
    // Same lock order as route transitions: route before delivery.
    const assigned = (await client.query<{ routeId: string | null }>(`SELECT d.route_id AS "routeId"
      FROM deliveries d JOIN courier_profiles p ON p.id=d.courier_profile_id
      WHERE d.id=$1 AND d.tenant_id=$2 AND p.user_id=$3`, [id, auth.tenantId, auth.userId])).rows[0];
    if (!assigned) throw notFound('Entrega não encontrada.');
    if (assigned.routeId) await client.query('SELECT id FROM routes WHERE id=$1 FOR UPDATE', [assigned.routeId]);
    const delivery = (await client.query<{ storeId: string; routeId: string | null; status: string;
      arrivedAt: string | null; waitingAtGateAt: string | null }>(`SELECT d.store_id AS "storeId",
        d.route_id AS "routeId",d.status,d.arrived_at AS "arrivedAt",d.waiting_at_gate_at AS "waitingAtGateAt"
      FROM deliveries d JOIN courier_profiles p ON p.id=d.courier_profile_id
      WHERE d.id=$1 AND d.tenant_id=$2 AND p.user_id=$3 FOR UPDATE OF d`, [id, auth.tenantId, auth.userId])).rows[0];
    if (!delivery) throw notFound('Entrega não encontrada.');
    if (delivery.routeId !== assigned.routeId) throw conflict('A rota foi alterada. Atualize e tente novamente.');
    return withIdempotency(client, auth, key, `delivery.customer-alert:${id}`, { action }, async () => {
      await requireCourierCheckin(client, auth, delivery.storeId);
      if (!['IN_ROUTE', 'NEXT_STOP'].includes(delivery.status)) throw conflict('Inicie o trajeto antes de avisar o cliente.');
      if (delivery.routeId) {
        const next = (await client.query<{ delivery_id: string; stop_type: string }>(`SELECT delivery_id,stop_type
          FROM route_stops WHERE route_id=$1 AND status='PENDING' ORDER BY sequence LIMIT 1`, [delivery.routeId])).rows[0];
        if (next?.delivery_id !== id || next.stop_type !== 'DELIVERY') throw conflict('Avise somente o cliente da próxima parada.');
      }
      const previous = action === 'ARRIVED' ? delivery.arrivedAt : delivery.waitingAtGateAt;
      if (previous) return { statusCode: 200, body: { deliveryId: id, action, recordedAt: previous, alreadyRecorded: true } };
      if (action === 'WAITING_AT_GATE' && !delivery.arrivedAt) throw conflict('Registre a chegada antes de avisar a portaria.');
      const column = action === 'ARRIVED' ? 'arrived_at' : 'waiting_at_gate_at';
      const eventType = action === 'ARRIVED' ? 'delivery.arrived' : 'delivery.waiting-at-gate';
      const recordedAt = new Date().toISOString();
      await client.query(`UPDATE deliveries SET ${column}=$2,updated_at=now(),version=version+1 WHERE id=$1`, [id, recordedAt]);
      await client.query(`INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload)
        VALUES($1,'delivery',$2,$3,$4::jsonb)`, [auth.tenantId, id, eventType, JSON.stringify({ deliveryId: id, recordedAt })]);
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId, action: eventType,
        entityType: 'delivery', entityId: id, afterData: { recordedAt } });
      return { statusCode: 200, body: { deliveryId: id, action, recordedAt, alreadyRecorded: false } };
    });
  });
}
