import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction } from '../../database/pool.js';
import type { ObjectStorage } from '../../integrations/objects/object-storage.js';
import { writeAudit } from '../../shared/audit.js';
import { AppError, conflict, notFound } from '../../shared/errors.js';
import { withIdempotency, type IdempotentResult } from '../../shared/idempotency.js';
import type { AuthContext } from '../auth/auth.types.js';
import { applyTransition, loadDelivery } from '../deliveries/delivery.service.js';

export const incidentTypes = [
  'DELIVERY_FAILURE', 'RECIPIENT_ABSENT', 'RECIPIENT_REFUSAL', 'DAMAGE',
  'ADDRESS_ISSUE', 'TRACKING_LOSS', 'RETURN', 'OTHER',
] as const;
export const incidentSeverities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const incidentStatuses = ['OPEN', 'UNDER_REVIEW', 'RETURN_IN_PROGRESS', 'RESOLVED'] as const;
export const incidentResolutions = ['RETURN_TO_STORE', 'NO_RETURN', 'RETRY_PLANNED', 'CUSTOMER_CANCELLED'] as const;

export type IncidentType = (typeof incidentTypes)[number];
export type IncidentSeverity = (typeof incidentSeverities)[number];
export type IncidentStatus = (typeof incidentStatuses)[number];
export type IncidentResolution = (typeof incidentResolutions)[number];

interface IncidentRow {
  id: string; tenantId: string; deliveryId: string; storeId: string; type: IncidentType;
  severity: IncidentSeverity; status: IncidentStatus; title: string; description: string;
  resolution: IncidentResolution | null; resolutionNotes: string | null; returnStartedAt: Date | null;
  resolvedAt: Date | null; version: number; createdAt: Date; updatedAt: Date;
  deliveryStatus: string; deliveryReference: string | null; recipientName: string; storeName: string;
  courierName: string | null; evidenceCount: number; proofCount: number;
}

interface IncidentScope {
  id: string; deliveryId: string; storeId: string; status: IncidentStatus; type: IncidentType;
  severity: IncidentSeverity; version: number; courierUserId: string | null;
  resolution: IncidentResolution | null;
}

interface OpenInput { deliveryId: string; type: IncidentType; severity: IncidentSeverity; title: string; description: string }
interface ReviewInput { type: IncidentType; severity: IncidentSeverity; notes: string }
interface ResolveInput { resolution: IncidentResolution; notes: string }

const incidentSelect = `
  SELECT incident.id, incident.tenant_id AS "tenantId", incident.delivery_id AS "deliveryId",
         incident.store_id AS "storeId", incident.type, incident.severity, incident.status,
         incident.title, incident.description, incident.resolution,
         incident.resolution_notes AS "resolutionNotes", incident.return_started_at AS "returnStartedAt",
         incident.resolved_at AS "resolvedAt", incident.version,
         incident.created_at AS "createdAt", incident.updated_at AS "updatedAt",
         delivery.status AS "deliveryStatus", delivery.external_reference AS "deliveryReference",
         delivery.recipient_name AS "recipientName", store.name AS "storeName",
         courier_user.name AS "courierName",
         (SELECT count(*)::int FROM incident_evidence evidence WHERE evidence.incident_id = incident.id) AS "evidenceCount",
         (SELECT count(*)::int FROM delivery_proofs proof WHERE proof.delivery_id = delivery.id) AS "proofCount"
  FROM incidents incident
  JOIN deliveries delivery ON delivery.id = incident.delivery_id
  JOIN stores store ON store.id = incident.store_id
  LEFT JOIN courier_profiles courier ON courier.id = delivery.courier_profile_id
  LEFT JOIN users courier_user ON courier_user.id = courier.user_id`;

function accessSql(roleParameter: number, storesParameter: number, userParameter: number): string {
  return `AND (
    $${roleParameter}::text = 'TENANT_MANAGER'
    OR ($${roleParameter}::text = 'STORE_OPERATOR' AND incident.store_id = ANY($${storesParameter}::uuid[]))
    OR ($${roleParameter}::text = 'COURIER' AND EXISTS (
      SELECT 1 FROM deliveries own_delivery
      JOIN courier_profiles own_profile ON own_profile.id = own_delivery.courier_profile_id
      WHERE own_delivery.id = incident.delivery_id AND own_profile.user_id = $${userParameter}
    ))
  )`;
}

function nextActions(row: Pick<IncidentRow, 'status'>): string[] {
  if (row.status === 'OPEN') return ['review', 'resolve'];
  if (row.status === 'UNDER_REVIEW') return ['resolve'];
  if (row.status === 'RETURN_IN_PROGRESS') return ['complete_return'];
  return [];
}

async function loadIncidentScope(client: PoolClient, auth: AuthContext, incidentId: string, lock = false): Promise<IncidentScope> {
  const result = await client.query<IncidentScope>(
    `SELECT incident.id, incident.delivery_id AS "deliveryId", incident.store_id AS "storeId",
            incident.status, incident.type, incident.severity, incident.version, incident.resolution,
            courier.user_id AS "courierUserId"
     FROM incidents incident
     JOIN deliveries delivery ON delivery.id = incident.delivery_id
     LEFT JOIN courier_profiles courier ON courier.id = delivery.courier_profile_id
     WHERE incident.id = $1 ${accessSql(2, 3, 4)} ${lock ? 'FOR UPDATE OF incident' : ''}`,
    [incidentId, auth.role, auth.storeIds, auth.userId],
  );
  const incident = result.rows[0];
  if (!incident) throw notFound('Ocorrência não encontrada.');
  return incident;
}

async function getIncidentInTransaction(client: PoolClient, auth: AuthContext, incidentId: string) {
  const result = await client.query<IncidentRow>(
    `${incidentSelect} WHERE incident.id = $1 ${accessSql(2, 3, 4)}`,
    [incidentId, auth.role, auth.storeIds, auth.userId],
  );
  const incident = result.rows[0];
  if (!incident) throw notFound('Ocorrência não encontrada.');
  const events = await client.query(
    `SELECT id, event_type AS "eventType", from_status AS "fromStatus", to_status AS "toStatus",
            notes, metadata, actor_user_id AS "actorUserId", incident_version AS version,
            created_at AS "createdAt"
     FROM incident_events WHERE incident_id = $1 ORDER BY incident_version`, [incidentId],
  );
  const evidence = await client.query(
    `SELECT id, mime_type AS "mimeType", size_bytes AS "sizeBytes", notes,
            created_by AS "createdBy", created_at AS "createdAt"
     FROM incident_evidence WHERE incident_id = $1 ORDER BY created_at DESC`, [incidentId],
  );
  const proofs = await client.query(
    `SELECT id, mime_type AS "mimeType", size_bytes AS "sizeBytes", recipient_name AS "recipientName",
            notes, public_visible AS "publicVisible", created_at AS "createdAt"
     FROM delivery_proofs WHERE delivery_id = $1 ORDER BY created_at DESC`, [incident.deliveryId],
  );
  return { ...incident, nextActions: nextActions(incident), events: events.rows, evidence: evidence.rows, proofs: proofs.rows };
}

async function appendEvent(
  client: PoolClient, auth: AuthContext, incidentId: string, eventType: string,
  fromStatus: IncidentStatus | null, toStatus: IncidentStatus, version: number,
  notes?: string, metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO incident_events
       (tenant_id, incident_id, event_type, from_status, to_status, notes, metadata, actor_user_id, incident_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [auth.tenantId, incidentId, eventType, fromStatus, toStatus, notes ?? null,
      JSON.stringify(metadata), auth.userId, version],
  );
}

async function publishIncidentEvent(
  client: PoolClient, auth: AuthContext, incidentId: string, eventType: string, payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'incident', $2, $3, $4::jsonb)`,
    [auth.tenantId, incidentId, eventType, JSON.stringify(payload)],
  );
}

export async function listIncidents(database: Database, auth: AuthContext, filters: {
  status?: IncidentStatus | undefined; type?: IncidentType | undefined;
  severity?: IncidentSeverity | undefined; storeId?: string | undefined; limit: number;
}) {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query<IncidentRow>(
      `${incidentSelect}
       WHERE ($1::incident_status IS NULL OR incident.status = $1)
         AND ($2::incident_type IS NULL OR incident.type = $2)
         AND ($3::incident_severity IS NULL OR incident.severity = $3)
         AND ($4::uuid IS NULL OR incident.store_id = $4)
         ${accessSql(5, 6, 7)}
       ORDER BY CASE incident.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
                CASE incident.status WHEN 'OPEN' THEN 0 WHEN 'UNDER_REVIEW' THEN 1 WHEN 'RETURN_IN_PROGRESS' THEN 2 ELSE 3 END,
                incident.created_at DESC
       LIMIT $8`,
      [filters.status ?? null, filters.type ?? null, filters.severity ?? null, filters.storeId ?? null,
        auth.role, auth.storeIds, auth.userId, filters.limit],
    );
    return { data: result.rows.map((incident) => ({ ...incident, nextActions: nextActions(incident) })) };
  });
}

export async function getIncident(database: Database, auth: AuthContext, incidentId: string) {
  return withTenantTransaction(database, auth, (client) => getIncidentInTransaction(client, auth, incidentId));
}

export async function openIncident(
  database: Database, auth: AuthContext, key: string, input: OpenInput, ip?: string,
): Promise<IdempotentResult<unknown>> {
  return withTenantTransaction(database, auth, async (client) =>
    withIdempotency(client, auth, key, 'incident.open', input, async () => {
      const delivery = await loadDelivery(client, auth, input.deliveryId);
      const incidentId = randomUUID();
      await client.query(
        `INSERT INTO incidents
           (id, tenant_id, delivery_id, store_id, type, severity, title, description, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [incidentId, auth.tenantId, delivery.id, delivery.storeId, input.type, input.severity,
          input.title, input.description, auth.userId],
      );
      await appendEvent(client, auth, incidentId, 'incident.opened', null, 'OPEN', 0, input.description);
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'incident.opened', entityType: 'incident',
        entityId: incidentId, afterData: { deliveryId: delivery.id, type: input.type, severity: input.severity },
        ...(ip === undefined ? {} : { ip }),
      });
      await publishIncidentEvent(client, auth, incidentId, 'incident.opened', {
        incidentId, deliveryId: delivery.id, severity: input.severity,
      });
      return { statusCode: 201, body: await getIncidentInTransaction(client, auth, incidentId) };
    }),
  );
}

export async function reviewIncident(
  database: Database, auth: AuthContext, key: string, incidentId: string, input: ReviewInput, ip?: string,
): Promise<IdempotentResult<unknown>> {
  return withTenantTransaction(database, auth, async (client) =>
    withIdempotency(client, auth, key, 'incident.review', { incidentId, ...input }, async () => {
      const before = await loadIncidentScope(client, auth, incidentId, true);
      if (before.status !== 'OPEN') throw conflict('Somente ocorrências abertas podem entrar em análise.');
      const update = await client.query<{ version: number }>(
        `UPDATE incidents SET status = 'UNDER_REVIEW', type = $2, severity = $3,
                reviewed_by = $4, version = version + 1
         WHERE id = $1 AND version = $5 RETURNING version`,
        [incidentId, input.type, input.severity, auth.userId, before.version],
      );
      if (!update.rowCount) throw conflict('A ocorrência foi alterada por outra operação.');
      const version = update.rows[0]!.version;
      await appendEvent(client, auth, incidentId, 'incident.review_started', before.status, 'UNDER_REVIEW', version,
        input.notes, { type: input.type, severity: input.severity });
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'incident.review_started',
        entityType: 'incident', entityId: incidentId,
        beforeData: { status: before.status, type: before.type, severity: before.severity },
        afterData: { status: 'UNDER_REVIEW', type: input.type, severity: input.severity },
        ...(ip === undefined ? {} : { ip }),
      });
      await publishIncidentEvent(client, auth, incidentId, 'incident.review_started', { incidentId, severity: input.severity });
      return { statusCode: 200, body: await getIncidentInTransaction(client, auth, incidentId) };
    }),
  );
}

export async function resolveIncident(
  database: Database, auth: AuthContext, key: string, incidentId: string, input: ResolveInput, ip?: string,
): Promise<IdempotentResult<unknown>> {
  return withTenantTransaction(database, auth, async (client) =>
    withIdempotency(client, auth, key, 'incident.resolve', { incidentId, ...input }, async () => {
      const before = await loadIncidentScope(client, auth, incidentId, true);
      if (!['OPEN', 'UNDER_REVIEW'].includes(before.status)) throw conflict('Esta ocorrência não aceita nova resolução.');
      let status: IncidentStatus = 'RESOLVED';
      if (input.resolution === 'RETURN_TO_STORE') {
        const delivery = await loadDelivery(client, auth, before.deliveryId, true);
        if (delivery.status !== 'DELIVERY_FAILED') {
          throw conflict('A devolução só pode começar após uma falha de entrega.');
        }
        await applyTransition(client, auth, delivery, 'RETURN_STARTED', input.notes, { incidentId });
        status = 'RETURN_IN_PROGRESS';
      }
      const update = await client.query<{ version: number }>(
        `UPDATE incidents SET status = $2, resolution = $3, resolution_notes = $4,
                return_started_at = CASE WHEN $2::incident_status = 'RETURN_IN_PROGRESS' THEN now() ELSE return_started_at END,
                resolved_at = CASE WHEN $2::incident_status = 'RESOLVED' THEN now() ELSE NULL END,
                resolved_by = CASE WHEN $2::incident_status = 'RESOLVED' THEN $5::uuid ELSE NULL END,
                version = version + 1
         WHERE id = $1 AND version = $6 RETURNING version`,
        [incidentId, status, input.resolution, input.notes, auth.userId, before.version],
      );
      if (!update.rowCount) throw conflict('A ocorrência foi alterada por outra operação.');
      const version = update.rows[0]!.version;
      const eventType = status === 'RETURN_IN_PROGRESS' ? 'incident.return_started' : 'incident.resolved';
      await appendEvent(client, auth, incidentId, eventType, before.status, status, version, input.notes,
        { resolution: input.resolution });
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: eventType,
        entityType: 'incident', entityId: incidentId,
        beforeData: { status: before.status }, afterData: { status, resolution: input.resolution },
        ...(ip === undefined ? {} : { ip }),
      });
      await publishIncidentEvent(client, auth, incidentId, eventType, { incidentId, deliveryId: before.deliveryId, status });
      return { statusCode: 200, body: await getIncidentInTransaction(client, auth, incidentId) };
    }),
  );
}

export async function completeReturn(
  database: Database, auth: AuthContext, key: string, incidentId: string, notes: string, ip?: string,
): Promise<IdempotentResult<unknown>> {
  return withTenantTransaction(database, auth, async (client) =>
    withIdempotency(client, auth, key, 'incident.complete_return', { incidentId, notes }, async () => {
      const before = await loadIncidentScope(client, auth, incidentId, true);
      if (before.status !== 'RETURN_IN_PROGRESS' || before.resolution !== 'RETURN_TO_STORE') {
        throw conflict('Esta ocorrência não possui devolução em andamento.');
      }
      const delivery = await loadDelivery(client, auth, before.deliveryId, true);
      await applyTransition(client, auth, delivery, 'RETURNED', notes, { incidentId });
      const update = await client.query<{ version: number }>(
        `UPDATE incidents SET status = 'RESOLVED', resolution_notes = $2,
                resolved_at = now(), resolved_by = $3, version = version + 1
         WHERE id = $1 AND version = $4 RETURNING version`,
        [incidentId, notes, auth.userId, before.version],
      );
      if (!update.rowCount) throw conflict('A ocorrência foi alterada por outra operação.');
      const version = update.rows[0]!.version;
      await appendEvent(client, auth, incidentId, 'incident.return_completed', before.status, 'RESOLVED', version, notes);
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'incident.return_completed',
        entityType: 'incident', entityId: incidentId,
        beforeData: { status: before.status }, afterData: { status: 'RESOLVED', deliveryStatus: 'RETURNED' },
        ...(ip === undefined ? {} : { ip }),
      });
      await publishIncidentEvent(client, auth, incidentId, 'incident.return_completed', {
        incidentId, deliveryId: before.deliveryId, status: 'RESOLVED',
      });
      return { statusCode: 200, body: await getIncidentInTransaction(client, auth, incidentId) };
    }),
  );
}

function extension(mimeType: string): string {
  return mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
}

export async function saveIncidentEvidence(
  database: Database, storage: ObjectStorage, auth: AuthContext, key: string, incidentId: string,
  input: { buffer: Buffer; mimeType: string; notes?: string }, ip?: string,
): Promise<IdempotentResult<unknown>> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(input.mimeType)) {
    throw new AppError(415, 'EVIDENCE_TYPE_NOT_ALLOWED', 'Envie uma imagem JPEG, PNG ou WebP.');
  }
  const checksum = createHash('sha256').update(input.buffer).digest('hex');
  const objectKey = `${auth.tenantId}/incidents/${incidentId}/${randomUUID()}.${extension(input.mimeType)}`;
  let stored = false;
  try {
    return await withTenantTransaction(database, auth, async (client) =>
      withIdempotency(client, auth, key, 'incident.evidence.upload', {
        incidentId, checksum, notes: input.notes ?? null,
      }, async () => {
        const incident = await loadIncidentScope(client, auth, incidentId, true);
        const existing = await client.query(
          `SELECT id, mime_type AS "mimeType", size_bytes AS "sizeBytes", notes, created_at AS "createdAt"
           FROM incident_evidence WHERE incident_id = $1 AND checksum_sha256 = $2`,
          [incidentId, checksum],
        );
        if (existing.rows[0]) return { statusCode: 200, body: existing.rows[0] };
        const object = await storage.put(objectKey, input.buffer);
        stored = true;
        const evidence = await client.query(
          `INSERT INTO incident_evidence
             (tenant_id, incident_id, object_url, object_key, mime_type, size_bytes,
              checksum_sha256, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, mime_type AS "mimeType", size_bytes AS "sizeBytes", notes, created_at AS "createdAt"`,
          [auth.tenantId, incidentId, object.objectUrl, objectKey, input.mimeType, input.buffer.length,
            checksum, input.notes ?? null, auth.userId],
        );
        const versionResult = await client.query<{ version: number }>(
          'UPDATE incidents SET version = version + 1 WHERE id = $1 RETURNING version', [incidentId],
        );
        await appendEvent(client, auth, incidentId, 'incident.evidence_added', incident.status, incident.status,
          versionResult.rows[0]!.version, input.notes, { evidenceId: evidence.rows[0]!.id, mimeType: input.mimeType });
        await writeAudit(client, {
          tenantId: auth.tenantId, actorUserId: auth.userId, action: 'incident.evidence_added',
          entityType: 'incident', entityId: incidentId,
          afterData: { evidenceId: evidence.rows[0]!.id, mimeType: input.mimeType, sizeBytes: input.buffer.length },
          ...(ip === undefined ? {} : { ip }),
        });
        return { statusCode: 201, body: evidence.rows[0] };
      }),
    );
  } catch (error) {
    if (stored) await storage.remove(objectKey);
    throw error;
  }
}

export async function openIncidentEvidence(
  database: Database, storage: ObjectStorage, auth: AuthContext, incidentId: string, evidenceId: string,
) {
  return withTenantTransaction(database, auth, async (client) => {
    await loadIncidentScope(client, auth, incidentId);
    const evidence = await client.query<{ object_key: string; mime_type: string }>(
      'SELECT object_key, mime_type FROM incident_evidence WHERE id = $1 AND incident_id = $2',
      [evidenceId, incidentId],
    );
    if (!evidence.rows[0]) throw notFound('Evidência não encontrada.');
    return { stream: await storage.open(evidence.rows[0].object_key), mimeType: evidence.rows[0].mime_type };
  });
}
