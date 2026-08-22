import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import type { ObjectStorage } from '../../integrations/objects/object-storage.js';
import { AppError } from '../../shared/errors.js';
import { parseIdempotencyKey, type IdempotentResult } from '../../shared/idempotency.js';
import { authenticate } from '../auth/auth.guard.js';
import { listDeliveryProofs, openDeliveryProof, openPublicDeliveryProof, saveDeliveryProof } from './proof.service.js';

const deliverySchema = z.object({ id: z.uuid() });
const proofSchema = z.object({ id: z.uuid(), proofId: z.uuid() });
const publicSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const metadataSchema = z.object({
  recipientName: z.string().trim().min(2).max(160).optional(),
  notes: z.string().trim().max(500).optional(),
  publicVisible: z.string().default('true').transform((value) => value !== 'false'),
});

function sendIdempotent<T>(reply: FastifyReply, result: IdempotentResult<T>) {
  reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false');
  return reply.status(result.statusCode).send(result.body);
}

export async function proofRoutes(
  app: FastifyInstance, database: Database, storage: ObjectStorage, env: AppEnv,
): Promise<void> {
  const auth = authenticate(env, database);
  app.post('/deliveries/:id/proofs', { preHandler: auth }, async (request, reply) => {
    const { id } = deliverySchema.parse(request.params);
    const metadata = metadataSchema.parse(request.query);
    const file = await request.file({ limits: { files: 1, fileSize: env.PROOF_MAX_FILE_SIZE_BYTES ?? 5_242_880, parts: 1 } });
    if (!file) throw new AppError(400, 'PROOF_FILE_REQUIRED', 'Selecione uma imagem do comprovante.');
    let buffer: Buffer;
    try { buffer = await file.toBuffer(); } catch {
      throw new AppError(413, 'PROOF_FILE_TOO_LARGE', 'O comprovante excede o limite permitido.');
    }
    const result = await saveDeliveryProof(database, storage, request.auth,
      parseIdempotencyKey(request.headers['idempotency-key']), id, {
        buffer, mimeType: file.mimetype, recipientName: metadata.recipientName,
        notes: metadata.notes, publicVisible: metadata.publicVisible,
      }, request.ip);
    return sendIdempotent(reply, result);
  });
  app.get('/deliveries/:id/proofs', { preHandler: auth }, async (request) => {
    const { id } = deliverySchema.parse(request.params);
    return listDeliveryProofs(database, request.auth, id);
  });
  app.get('/deliveries/:id/proofs/:proofId/file', { preHandler: auth }, async (request, reply) => {
    const { id, proofId } = proofSchema.parse(request.params);
    const proof = await openDeliveryProof(database, storage, request.auth, id, proofId);
    reply.header('Cache-Control', 'private, no-store').type(proof.mimeType);
    return reply.send(proof.stream);
  });
  app.get('/public/tracking/:token/proof', async (request, reply) => {
    const { token } = publicSchema.parse(request.params);
    const proof = await openPublicDeliveryProof(database, storage, env, token);
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').type(proof.mimeType);
    return reply.send(proof.stream);
  });
}
