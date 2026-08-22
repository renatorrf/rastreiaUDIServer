import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { writeAudit } from '../../shared/audit.js';
import type { AuthContext } from '../auth/auth.types.js';

interface FailedDelivery {
  id: string;
  storeId: string;
  version: number;
}

export async function createFailureIncident(
  client: PoolClient,
  auth: AuthContext,
  delivery: FailedDelivery,
  reason: string,
  ip?: string,
): Promise<string> {
  const incidentId = randomUUID();
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO incidents
       (id, tenant_id, delivery_id, store_id, type, severity, title, description,
        source_delivery_version, created_by)
     VALUES ($1, $2, $3, $4, 'DELIVERY_FAILURE', 'HIGH', 'Falha na entrega', $5, $6, $7)
     ON CONFLICT (tenant_id, delivery_id, source_delivery_version) DO NOTHING
     RETURNING id`,
    [incidentId, auth.tenantId, delivery.id, delivery.storeId, reason, delivery.version, auth.userId],
  );
  const createdId = inserted.rows[0]?.id;
  if (!createdId) {
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM incidents WHERE tenant_id = $1 AND delivery_id = $2 AND source_delivery_version = $3',
      [auth.tenantId, delivery.id, delivery.version],
    );
    return existing.rows[0]!.id;
  }
  await client.query(
    `INSERT INTO incident_events
       (tenant_id, incident_id, event_type, to_status, notes, actor_user_id, incident_version)
     VALUES ($1, $2, 'incident.opened_from_delivery_failure', 'OPEN', $3, $4, 0)`,
    [auth.tenantId, createdId, reason, auth.userId],
  );
  await writeAudit(client, {
    tenantId: auth.tenantId, actorUserId: auth.userId, action: 'incident.opened_from_delivery_failure',
    entityType: 'incident', entityId: createdId,
    afterData: { deliveryId: delivery.id, type: 'DELIVERY_FAILURE', severity: 'HIGH', status: 'OPEN' },
    ...(ip === undefined ? {} : { ip }),
  });
  await client.query(
    `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'incident', $2, 'incident.opened', $3::jsonb)`,
    [auth.tenantId, createdId, JSON.stringify({ incidentId: createdId, deliveryId: delivery.id, severity: 'HIGH' })],
  );
  return createdId;
}
