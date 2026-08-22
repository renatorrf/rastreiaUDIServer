import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import type { ObjectStorage } from '../../integrations/objects/object-storage.js';
import { AppError } from '../../shared/errors.js';
import { parseIdempotencyKey, type IdempotentResult } from '../../shared/idempotency.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import {
  completeReturn, getIncident, incidentResolutions, incidentSeverities, incidentStatuses,
  incidentTypes, listIncidents, openIncident, openIncidentEvidence, resolveIncident,
  reviewIncident, saveIncidentEvidence,
} from './incident.service.js';

const idSchema = z.object({ id: z.uuid() });
const evidenceIdSchema = z.object({ id: z.uuid(), evidenceId: z.uuid() });
const listSchema = z.object({
  status: z.enum(incidentStatuses).optional(), type: z.enum(incidentTypes).optional(),
  severity: z.enum(incidentSeverities).optional(), storeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const openSchema = z.object({
  deliveryId: z.uuid(), type: z.enum(incidentTypes), severity: z.enum(incidentSeverities),
  title: z.string().trim().min(3).max(160), description: z.string().trim().min(3).max(2000),
});
const reviewSchema = z.object({
  type: z.enum(incidentTypes), severity: z.enum(incidentSeverities),
  notes: z.string().trim().min(3).max(2000),
});
const resolveSchema = z.object({
  resolution: z.enum(incidentResolutions), notes: z.string().trim().min(3).max(2000),
});
const notesSchema = z.object({ notes: z.string().trim().min(3).max(2000) });
const evidenceMetadataSchema = z.object({ notes: z.string().trim().max(500).optional() });

function keyFrom(request: FastifyRequest): string {
  return parseIdempotencyKey(request.headers['idempotency-key']);
}

function sendIdempotent<T>(reply: FastifyReply, result: IdempotentResult<T>) {
  reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false');
  return reply.status(result.statusCode).send(result.body);
}

export async function incidentRoutes(
  app: FastifyInstance, database: Database, storage: ObjectStorage, env: AppEnv,
): Promise<void> {
  const auth = authenticate(env, database);

  app.get('/incidents', { preHandler: auth }, async (request) =>
    listIncidents(database, request.auth, listSchema.parse(request.query)));

  app.get('/incidents/:id', { preHandler: auth }, async (request) => {
    const { id } = idSchema.parse(request.params);
    return getIncident(database, request.auth, id);
  });

  app.post('/incidents', { preHandler: auth }, async (request, reply) => {
    const result = await openIncident(database, request.auth, keyFrom(request), openSchema.parse(request.body), request.ip);
    return sendIdempotent(reply, result);
  });

  app.post('/incidents/:id/review', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const result = await reviewIncident(database, request.auth, keyFrom(request), id, reviewSchema.parse(request.body), request.ip);
    return sendIdempotent(reply, result);
  });

  app.post('/incidents/:id/resolve', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const result = await resolveIncident(database, request.auth, keyFrom(request), id, resolveSchema.parse(request.body), request.ip);
    return sendIdempotent(reply, result);
  });

  app.post('/incidents/:id/complete-return', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR', 'COURIER')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const { notes } = notesSchema.parse(request.body);
    const result = await completeReturn(database, request.auth, keyFrom(request), id, notes, request.ip);
    return sendIdempotent(reply, result);
  });

  app.post('/incidents/:id/evidence', { preHandler: auth }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const metadata = evidenceMetadataSchema.parse(request.query);
    const file = await request.file({ limits: {
      files: 1, fileSize: env.PROOF_MAX_FILE_SIZE_BYTES ?? 5_242_880, parts: 1,
    } });
    if (!file) throw new AppError(400, 'EVIDENCE_FILE_REQUIRED', 'Selecione uma imagem da ocorrência.');
    let buffer: Buffer;
    try { buffer = await file.toBuffer(); } catch {
      throw new AppError(413, 'EVIDENCE_FILE_TOO_LARGE', 'A evidência excede o limite permitido.');
    }
    const result = await saveIncidentEvidence(database, storage, request.auth, keyFrom(request), id, {
      buffer, mimeType: file.mimetype, ...(metadata.notes === undefined ? {} : { notes: metadata.notes }),
    }, request.ip);
    return sendIdempotent(reply, result);
  });

  app.get('/incidents/:id/evidence/:evidenceId/file', { preHandler: auth }, async (request, reply) => {
    const { id, evidenceId } = evidenceIdSchema.parse(request.params);
    const evidence = await openIncidentEvidence(database, storage, request.auth, id, evidenceId);
    reply.header('Cache-Control', 'private, no-store').type(evidence.mimeType);
    return reply.send(evidence.stream);
  });
}
