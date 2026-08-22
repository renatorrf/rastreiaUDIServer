import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import {
  setTenantContext, withRuntimeTransaction, withTenantTransaction, type Database,
} from '../../database/pool.js';
import type { ObjectStorage } from '../../integrations/objects/object-storage.js';
import { writeAudit } from '../../shared/audit.js';
import { AppError, forbidden, notFound } from '../../shared/errors.js';
import { withIdempotency } from '../../shared/idempotency.js';
import type { AuthContext } from '../auth/auth.types.js';
import { resolvePublicTrackingSocket } from '../tracking/tracking.service.js';

const anonymousUserId = '00000000-0000-0000-0000-000000000000';
const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface ProofInput {
  buffer: Buffer;
  mimeType: string;
  recipientName?: string | null | undefined;
  notes?: string | null | undefined;
  publicVisible: boolean;
}

interface DeliveryProofScope { id: string; storeId: string; status: string; courierUserId: string | null }
interface ProofRow {
  id: string; deliveryId: string; objectKey: string; mimeType: string; sizeBytes: number;
  recipientName: string | null; notes: string | null; publicVisible: boolean; createdAt: Date;
}

function extension(mimeType: string): string {
  return mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
}

async function deliveryScope(client: PoolClient, auth: AuthContext, deliveryId: string): Promise<DeliveryProofScope> {
  const result = await client.query<{
    id: string; store_id: string; status: string; courier_user_id: string | null;
  }>(
    `SELECT delivery.id, delivery.store_id, delivery.status, courier.user_id AS courier_user_id
     FROM deliveries delivery
     LEFT JOIN courier_profiles courier ON courier.id = delivery.courier_profile_id
     WHERE delivery.id = $1 AND delivery.tenant_id = $2`,
    [deliveryId, auth.tenantId],
  );
  const row = result.rows[0];
  if (!row) throw notFound('Entrega não encontrada.');
  const allowed = auth.role === 'TENANT_MANAGER'
    || (auth.role === 'STORE_OPERATOR' && auth.storeIds.includes(row.store_id))
    || (auth.role === 'COURIER' && row.courier_user_id === auth.userId);
  if (!allowed) throw forbidden('Você não possui acesso ao comprovante desta entrega.');
  return { id: row.id, storeId: row.store_id, status: row.status, courierUserId: row.courier_user_id };
}

function mapProof(row: ProofRow) {
  return { id: row.id, deliveryId: row.deliveryId, mimeType: row.mimeType,
    sizeBytes: row.sizeBytes, recipientName: row.recipientName, notes: row.notes,
    publicVisible: row.publicVisible, createdAt: row.createdAt };
}

export async function saveDeliveryProof(
  database: Database, storage: ObjectStorage, auth: AuthContext, idempotencyKey: string,
  deliveryId: string, input: ProofInput, ip?: string,
) {
  if (!allowedMimeTypes.has(input.mimeType)) {
    throw new AppError(415, 'PROOF_TYPE_NOT_ALLOWED', 'Envie uma imagem JPEG, PNG ou WebP.');
  }
  const checksum = createHash('sha256').update(input.buffer).digest('hex');
  const objectKey = `${auth.tenantId}/${deliveryId}/${randomUUID()}.${extension(input.mimeType)}`;
  let stored = false;
  try {
    return await withTenantTransaction(database, auth, async (client) =>
      withIdempotency(client, auth, idempotencyKey, 'delivery.proof.upload', {
        deliveryId, checksum, recipientName: input.recipientName ?? null,
        notes: input.notes ?? null, publicVisible: input.publicVisible,
      }, async () => {
        const delivery = await deliveryScope(client, auth, deliveryId);
        if (!['IN_ROUTE', 'NEXT_STOP', 'DELIVERED'].includes(delivery.status)) {
          throw new AppError(422, 'PROOF_NOT_ALLOWED', 'O comprovante pode ser anexado durante ou após a entrega.');
        }
        const existing = await client.query<ProofRow>(
          `SELECT id, delivery_id AS "deliveryId", object_key AS "objectKey", mime_type AS "mimeType",
                  size_bytes AS "sizeBytes", recipient_name AS "recipientName", notes,
                  public_visible AS "publicVisible", created_at AS "createdAt"
           FROM delivery_proofs WHERE tenant_id = $1 AND delivery_id = $2 AND checksum_sha256 = $3`,
          [auth.tenantId, deliveryId, checksum],
        );
        if (existing.rows[0]) return { statusCode: 200, body: mapProof(existing.rows[0]) };

        const object = await storage.put(objectKey, input.buffer);
        stored = true;
        const proof = await client.query<ProofRow>(
          `INSERT INTO delivery_proofs
             (tenant_id, delivery_id, object_url, object_key, mime_type, size_bytes,
              checksum_sha256, recipient_name, notes, public_visible, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id, delivery_id AS "deliveryId", object_key AS "objectKey",
                     mime_type AS "mimeType", size_bytes AS "sizeBytes",
                     recipient_name AS "recipientName", notes,
                     public_visible AS "publicVisible", created_at AS "createdAt"`,
          [auth.tenantId, deliveryId, object.objectUrl, objectKey, input.mimeType,
            input.buffer.length, checksum, input.recipientName ?? null, input.notes ?? null,
            input.publicVisible, auth.userId],
        );
        await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
          action: 'delivery_proof.created', entityType: 'delivery', entityId: deliveryId,
          afterData: { proofId: proof.rows[0]!.id, mimeType: input.mimeType,
            sizeBytes: input.buffer.length, publicVisible: input.publicVisible },
          ...(ip === undefined ? {} : { ip }) });
        return { statusCode: 201, body: mapProof(proof.rows[0]!) };
      }),
    );
  } catch (error) {
    if (stored) await storage.remove(objectKey);
    throw error;
  }
}

export async function listDeliveryProofs(database: Database, auth: AuthContext, deliveryId: string) {
  return withTenantTransaction(database, auth, async (client) => {
    await deliveryScope(client, auth, deliveryId);
    const result = await client.query<ProofRow>(
      `SELECT id, delivery_id AS "deliveryId", object_key AS "objectKey", mime_type AS "mimeType",
              size_bytes AS "sizeBytes", recipient_name AS "recipientName", notes,
              public_visible AS "publicVisible", created_at AS "createdAt"
       FROM delivery_proofs WHERE delivery_id = $1 ORDER BY created_at DESC`, [deliveryId],
    );
    return { data: result.rows.map(mapProof) };
  });
}

export async function openDeliveryProof(
  database: Database, storage: ObjectStorage, auth: AuthContext, deliveryId: string, proofId: string,
) {
  const proof = await withTenantTransaction(database, auth, async (client) => {
    await deliveryScope(client, auth, deliveryId);
    const result = await client.query<{ object_key: string; mime_type: string }>(
      `SELECT object_key, mime_type FROM delivery_proofs WHERE id = $1 AND delivery_id = $2`,
      [proofId, deliveryId],
    );
    if (!result.rows[0]) throw notFound('Comprovante não encontrado.');
    return result.rows[0];
  });
  return { stream: await storage.open(proof.object_key), mimeType: proof.mime_type };
}

export async function openPublicDeliveryProof(
  database: Database, storage: ObjectStorage, env: AppEnv, token: string,
) {
  const scope = await resolvePublicTrackingSocket(database, env, token);
  const proof = await withRuntimeTransaction(database, async (client) => {
    await setTenantContext(client, { tenantId: scope.tenantId, userId: anonymousUserId });
    const result = await client.query<{ object_key: string; mime_type: string }>(
      `SELECT proof.object_key, proof.mime_type
       FROM delivery_proofs proof
       JOIN deliveries delivery ON delivery.id = proof.delivery_id
       JOIN tracking_tokens token ON token.delivery_id = delivery.id
       WHERE token.id = $1 AND delivery.id = $2 AND delivery.status = 'DELIVERED'
         AND proof.public_visible AND token.revoked_at IS NULL AND token.expires_at > now()
       ORDER BY proof.created_at DESC LIMIT 1`, [scope.tokenId, scope.deliveryId],
    );
    if (!result.rows[0]) throw notFound('Comprovante não encontrado.');
    return result.rows[0];
  });
  return { stream: await storage.open(proof.object_key), mimeType: proof.mime_type };
}
