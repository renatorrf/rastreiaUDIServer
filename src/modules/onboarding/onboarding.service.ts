import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction } from '../../database/pool.js';
import type { ObjectStorage } from '../../integrations/objects/object-storage.js';
import { writeAudit } from '../../shared/audit.js';
import { AppError, conflict, forbidden, notFound } from '../../shared/errors.js';
import { withIdempotency, type IdempotentResult } from '../../shared/idempotency.js';
import type { AuthContext } from '../auth/auth.types.js';

export interface RequirementInput {
  code: string; label: string; description?: string | null | undefined; required: boolean;
  requiresReview: boolean; requiresExpiry: boolean; active: boolean; sortOrder: number;
}

interface DocumentUploadInput { buffer: Buffer; mimeType: string; expiresAt?: string | null }

const mimeExtensions: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
};

function validMagic(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString() === '%PDF-';
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/webp') return buffer.subarray(0, 4).toString() === 'RIFF'
    && buffer.subarray(8, 12).toString() === 'WEBP';
  return false;
}

async function profileForUser(client: PoolClient, auth: AuthContext): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT profile.id FROM courier_profiles profile
     JOIN tenant_users membership ON membership.user_id = profile.user_id
       AND membership.tenant_id = $1 AND membership.role = 'COURIER'
     WHERE profile.user_id = $2`, [auth.tenantId, auth.userId],
  );
  if (!result.rows[0]) throw forbidden('Somente entregadores possuem onboarding próprio.');
  return result.rows[0].id;
}

async function validateTenantCourier(client: PoolClient, tenantId: string, courierId: string): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM courier_profiles profile
     JOIN tenant_users membership ON membership.user_id = profile.user_id
       AND membership.tenant_id = $1 AND membership.role = 'COURIER'
     WHERE profile.id = $2`, [tenantId, courierId],
  );
  if (!result.rowCount) throw notFound('Entregador não encontrado nesta empresa.');
}

async function appendEvent(
  client: PoolClient, auth: AuthContext, courierId: string, entityType: string,
  entityId: string, eventType: string, metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO onboarding_events
       (tenant_id, courier_profile_id, entity_type, entity_id, event_type, metadata, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [auth.tenantId, courierId, entityType, entityId, eventType, JSON.stringify(metadata), auth.userId],
  );
}

async function onboardingContext(client: PoolClient, auth: AuthContext, courierId: string) {
  await validateTenantCourier(client, auth.tenantId, courierId);
  const courier = await client.query(
    `SELECT profile.id, account.name, account.email, profile.phone,
            profile.vehicle_type AS "profileVehicleType", membership.status AS "membershipStatus"
     FROM courier_profiles profile JOIN users account ON account.id = profile.user_id
     JOIN tenant_users membership ON membership.user_id = account.id AND membership.tenant_id = $1
     WHERE profile.id = $2`, [auth.tenantId, courierId],
  );
  const requirements = await client.query<{
    id: string; code: string; label: string; description: string | null; required: boolean;
    requiresReview: boolean; requiresExpiry: boolean; active: boolean; sortOrder: number; updatedAt: Date;
  }>(
    `SELECT id, code, label, description, required, requires_review AS "requiresReview",
            requires_expiry AS "requiresExpiry", active, sort_order AS "sortOrder", updated_at AS "updatedAt"
     FROM onboarding_requirements WHERE active ORDER BY sort_order, label`,
  );
  const documents = await client.query<{
    id: string; requirementId: string; mimeType: string; sizeBytes: number; checksum: string;
    status: string; expiresAt: string | null; reviewNotes: string | null; reviewedAt: Date | null; createdAt: Date;
  }>(
    `SELECT DISTINCT ON (document.requirement_id)
            document.id, document.requirement_id AS "requirementId", document.mime_type AS "mimeType",
            document.size_bytes AS "sizeBytes", document.checksum_sha256 AS checksum,
            CASE WHEN document.expires_at < current_date THEN 'EXPIRED'::text ELSE document.status::text END AS status,
            document.expires_at AS "expiresAt", document.review_notes AS "reviewNotes",
            document.reviewed_at AS "reviewedAt", document.created_at AS "createdAt"
     FROM courier_documents document WHERE document.courier_profile_id = $1
     ORDER BY document.requirement_id, document.created_at DESC`, [courierId],
  );
  const vehicles = await client.query(
    `SELECT id, type_label AS "typeLabel", plate_masked AS "plateMasked", capacity_kg::float AS "capacityKg",
            notes, status, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM courier_vehicles WHERE courier_profile_id = $1 ORDER BY status, created_at DESC`, [courierId],
  );
  const validRequirementIds = new Set(documents.rows
    .filter((document) => document.status === 'APPROVED').map((document) => document.requirementId));
  const required = requirements.rows.filter((requirement) => requirement.required);
  const completedRequired = required.filter((requirement) => validRequirementIds.has(requirement.id)).length;
  return {
    courier: courier.rows[0], requirements: requirements.rows, documents: documents.rows, vehicles: vehicles.rows,
    readiness: {
      state: requirements.rowCount === 0 ? 'NOT_CONFIGURED'
        : completedRequired === required.length ? 'READY' : 'INCOMPLETE',
      required: required.length, completedRequired,
    },
  };
}

export async function getMyOnboarding(database: Database, auth: AuthContext) {
  return withTenantTransaction(database, auth, async (client) =>
    onboardingContext(client, auth, await profileForUser(client, auth)));
}

export async function getCourierOnboarding(database: Database, auth: AuthContext, courierId: string) {
  return withTenantTransaction(database, auth, (client) => onboardingContext(client, auth, courierId));
}

export async function listRequirements(database: Database, auth: AuthContext) {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query(
      `SELECT id, code, label, description, required, requires_review AS "requiresReview",
              requires_expiry AS "requiresExpiry", active, sort_order AS "sortOrder", updated_at AS "updatedAt"
       FROM onboarding_requirements ORDER BY active DESC, sort_order, label`,
    );
    return { data: result.rows };
  });
}

export async function saveRequirement(
  database: Database, auth: AuthContext, input: RequirementInput, requirementId?: string, ip?: string,
) {
  return withTenantTransaction(database, auth, async (client) => {
    const before = requirementId
      ? (await client.query('SELECT * FROM onboarding_requirements WHERE id = $1', [requirementId])).rows[0]
      : null;
    if (requirementId && !before) throw notFound('Requisito não encontrado.');
    try {
      const result = requirementId
        ? await client.query(
          `UPDATE onboarding_requirements SET code = $2, label = $3, description = $4, required = $5,
                  requires_review = $6, requires_expiry = $7, active = $8, sort_order = $9, updated_by = $10
           WHERE id = $1 RETURNING id, code, label, description, required, requires_review AS "requiresReview",
             requires_expiry AS "requiresExpiry", active, sort_order AS "sortOrder", updated_at AS "updatedAt"`,
          [requirementId, input.code, input.label, input.description ?? null, input.required,
            input.requiresReview, input.requiresExpiry, input.active, input.sortOrder, auth.userId],
        )
        : await client.query(
          `INSERT INTO onboarding_requirements
             (tenant_id, code, label, description, required, requires_review, requires_expiry,
              active, sort_order, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
           RETURNING id, code, label, description, required, requires_review AS "requiresReview",
             requires_expiry AS "requiresExpiry", active, sort_order AS "sortOrder", updated_at AS "updatedAt"`,
          [auth.tenantId, input.code, input.label, input.description ?? null, input.required,
            input.requiresReview, input.requiresExpiry, input.active, input.sortOrder, auth.userId],
        );
      const saved = result.rows[0];
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId,
        action: requirementId ? 'onboarding.requirement_updated' : 'onboarding.requirement_created',
        entityType: 'onboarding_requirement', entityId: saved.id, beforeData: before, afterData: saved,
        ...(ip === undefined ? {} : { ip }),
      });
      return saved;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('Já existe um requisito com este código.');
      throw error;
    }
  });
}

export async function uploadMyDocument(
  database: Database, storage: ObjectStorage, auth: AuthContext, key: string,
  requirementId: string, input: DocumentUploadInput, ip?: string,
): Promise<IdempotentResult<unknown>> {
  const extension = mimeExtensions[input.mimeType];
  if (!extension || !validMagic(input.buffer, input.mimeType)) {
    throw new AppError(415, 'DOCUMENT_TYPE_NOT_ALLOWED', 'Envie PDF, JPG, PNG ou WebP válido.');
  }
  let storedKey: string | undefined;
  try {
    return await withTenantTransaction(database, auth, async (client) => {
      const courierId = await profileForUser(client, auth);
      const requirement = (await client.query<{
        id: string; requires_expiry: boolean; requires_review: boolean;
      }>('SELECT id, requires_expiry, requires_review FROM onboarding_requirements WHERE id = $1 AND active',
      [requirementId])).rows[0];
      if (!requirement) throw notFound('Requisito ativo não encontrado.');
      if (requirement.requires_expiry && !input.expiresAt) {
        throw new AppError(400, 'EXPIRY_REQUIRED', 'Informe a validade deste documento.');
      }
      if (input.expiresAt && input.expiresAt < new Date().toISOString().slice(0, 10)) {
        throw new AppError(400, 'DOCUMENT_ALREADY_EXPIRED', 'O documento informado já está vencido.');
      }
      return withIdempotency(client, auth, key, 'onboarding.document_upload', {
        requirementId, checksum: createHash('sha256').update(input.buffer).digest('hex'), expiresAt: input.expiresAt,
      }, async () => {
        storedKey = `${auth.tenantId}/onboarding/${courierId}/${randomUUID()}.${extension}`;
        const object = await storage.put(storedKey, input.buffer);
        const status = requirement.requires_review ? 'PENDING' : 'APPROVED';
        const document = await client.query<{ id: string; requirementId: string; mimeType: string;
          sizeBytes: number; checksum: string; expiresAt: string | null; status: string; createdAt: Date }>(
          `INSERT INTO courier_documents
             (tenant_id, courier_profile_id, requirement_id, object_url, object_key, mime_type,
              size_bytes, checksum_sha256, expires_at, status, submitted_by,
              reviewed_by, reviewed_at, review_notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::onboarding_submission_status,$11,
                   CASE WHEN $10::text = 'APPROVED' THEN $11::uuid END,
                   CASE WHEN $10::text = 'APPROVED' THEN now() END,
                   CASE WHEN $10::text = 'APPROVED' THEN 'Aprovação automática pela regra da empresa' END)
           RETURNING id, requirement_id AS "requirementId", mime_type AS "mimeType",
             size_bytes AS "sizeBytes", checksum_sha256 AS checksum, expires_at AS "expiresAt",
             status, created_at AS "createdAt"`,
          [auth.tenantId, courierId, requirementId, object.objectUrl, storedKey, input.mimeType,
            input.buffer.length, createHash('sha256').update(input.buffer).digest('hex'),
            input.expiresAt ?? null, status, auth.userId],
        );
        const saved = document.rows[0]!;
        await appendEvent(client, auth, courierId, 'document', saved.id, 'onboarding.document_submitted', { requirementId, status });
        await writeAudit(client, {
          tenantId: auth.tenantId, actorUserId: auth.userId, action: 'onboarding.document_submitted',
          entityType: 'courier_document', entityId: saved.id,
          afterData: { requirementId, mimeType: input.mimeType, sizeBytes: input.buffer.length, status },
          ...(ip === undefined ? {} : { ip }),
        });
        return { statusCode: 201, body: saved };
      });
    });
  } catch (error) {
    if (storedKey) await storage.remove(storedKey);
    throw error;
  }
}

export async function listReviewQueue(database: Database, auth: AuthContext) {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query(
      `SELECT document.id, document.courier_profile_id AS "courierId", account.name AS "courierName",
              requirement.label AS "requirementLabel", document.mime_type AS "mimeType",
              document.size_bytes AS "sizeBytes", document.expires_at AS "expiresAt",
              document.status, document.created_at AS "createdAt"
       FROM courier_documents document
       JOIN onboarding_requirements requirement ON requirement.id = document.requirement_id
       JOIN courier_profiles profile ON profile.id = document.courier_profile_id
       JOIN users account ON account.id = profile.user_id
       WHERE document.status = 'PENDING'
         AND (document.expires_at IS NULL OR document.expires_at >= current_date)
       ORDER BY document.created_at`,
    );
    return { data: result.rows };
  });
}

export async function reviewDocument(
  database: Database, auth: AuthContext, key: string, documentId: string,
  input: { status: 'APPROVED' | 'REJECTED'; notes: string }, ip?: string,
): Promise<IdempotentResult<unknown>> {
  return withTenantTransaction(database, auth, async (client) =>
    withIdempotency(client, auth, key, 'onboarding.document_review', { documentId, ...input }, async () => {
      const current = (await client.query<{ courier_profile_id: string; status: string; expired: boolean }>(
        `SELECT courier_profile_id, status, (expires_at < current_date) AS expired
         FROM courier_documents WHERE id = $1 FOR UPDATE`, [documentId],
      )).rows[0];
      if (!current) throw notFound('Documento não encontrado.');
      if (current.expired) throw conflict('Documento vencido não pode ser aprovado ou rejeitado.');
      if (current.status !== 'PENDING') throw conflict('Este documento já foi revisado.');
      const result = await client.query(
        `UPDATE courier_documents SET status = $2, review_notes = $3, reviewed_by = $4, reviewed_at = now()
         WHERE id = $1 RETURNING id, courier_profile_id AS "courierId", requirement_id AS "requirementId",
           status, review_notes AS "reviewNotes", reviewed_at AS "reviewedAt"`,
        [documentId, input.status, input.notes, auth.userId],
      );
      await appendEvent(client, auth, current.courier_profile_id, 'document', documentId,
        `onboarding.document_${input.status.toLowerCase()}`, { notes: input.notes });
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: `onboarding.document_${input.status.toLowerCase()}`,
        entityType: 'courier_document', entityId: documentId,
        beforeData: { status: current.status }, afterData: result.rows[0], ...(ip === undefined ? {} : { ip }),
      });
      await client.query(
        `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'courier_document', $2, $3, $4::jsonb)`,
        [auth.tenantId, documentId, `onboarding.document_${input.status.toLowerCase()}`,
          JSON.stringify({ documentId, courierId: current.courier_profile_id, status: input.status })],
      );
      return { statusCode: 200, body: result.rows[0] };
    }),
  );
}

export async function addMyVehicle(
  database: Database, auth: AuthContext, input: { typeLabel: string;
    plate?: string | null | undefined; capacityKg?: number | null | undefined;
    notes?: string | null | undefined }, ip?: string,
) {
  return withTenantTransaction(database, auth, async (client) => {
    const courierId = await profileForUser(client, auth);
    const normalizedPlate = input.plate?.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || null;
    const plateHash = normalizedPlate ? createHash('sha256').update(`${auth.tenantId}:${normalizedPlate}`).digest('hex') : null;
    const plateMasked = normalizedPlate ? `***${normalizedPlate.slice(-4)}` : null;
    try {
      const result = await client.query<{ id: string; typeLabel: string; plateMasked: string | null;
        capacityKg: number | null; notes: string | null; status: string; createdAt: Date }>(
        `INSERT INTO courier_vehicles
           (tenant_id, courier_profile_id, type_label, plate_masked, plate_hash, capacity_kg,
            notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
         RETURNING id, type_label AS "typeLabel", plate_masked AS "plateMasked",
           capacity_kg::float AS "capacityKg", notes, status, created_at AS "createdAt"`,
        [auth.tenantId, courierId, input.typeLabel, plateMasked, plateHash,
          input.capacityKg ?? null, input.notes ?? null, auth.userId],
      );
      const vehicle = result.rows[0]!;
      await appendEvent(client, auth, courierId, 'vehicle', vehicle.id, 'onboarding.vehicle_added', {
        typeLabel: input.typeLabel, plateMasked,
      });
      await writeAudit(client, {
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'onboarding.vehicle_added',
        entityType: 'courier_vehicle', entityId: vehicle.id,
        afterData: { typeLabel: input.typeLabel, plateMasked, capacityKg: input.capacityKg ?? null },
        ...(ip === undefined ? {} : { ip }),
      });
      return vehicle;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('Este veículo já está cadastrado na empresa.');
      throw error;
    }
  });
}

export async function setMyVehicleStatus(
  database: Database, auth: AuthContext, vehicleId: string, status: 'ACTIVE' | 'INACTIVE', ip?: string,
) {
  return withTenantTransaction(database, auth, async (client) => {
    const courierId = await profileForUser(client, auth);
    const result = await client.query(
      `UPDATE courier_vehicles SET status = $3, updated_by = $4
       WHERE id = $1 AND courier_profile_id = $2
       RETURNING id, type_label AS "typeLabel", plate_masked AS "plateMasked", status, updated_at AS "updatedAt"`,
      [vehicleId, courierId, status, auth.userId],
    );
    if (!result.rowCount) throw notFound('Veículo não encontrado.');
    await appendEvent(client, auth, courierId, 'vehicle', vehicleId, 'onboarding.vehicle_status_changed', { status });
    await writeAudit(client, {
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'onboarding.vehicle_status_changed',
      entityType: 'courier_vehicle', entityId: vehicleId, afterData: { status }, ...(ip === undefined ? {} : { ip }),
    });
    return result.rows[0];
  });
}

export async function openDocument(
  database: Database, storage: ObjectStorage, auth: AuthContext, documentId: string,
) {
  const document = await withTenantTransaction(database, auth, async (client) => {
    const result = await client.query<{ object_key: string; mime_type: string; courier_user_id: string }>(
      `SELECT document.object_key, document.mime_type, profile.user_id AS courier_user_id
       FROM courier_documents document JOIN courier_profiles profile ON profile.id = document.courier_profile_id
       WHERE document.id = $1`, [documentId],
    );
    const row = result.rows[0];
    if (!row || (auth.role !== 'TENANT_MANAGER' && row.courier_user_id !== auth.userId)) {
      throw notFound('Documento não encontrado.');
    }
    return row;
  });
  return { stream: await storage.open(document.object_key), mimeType: document.mime_type };
}
