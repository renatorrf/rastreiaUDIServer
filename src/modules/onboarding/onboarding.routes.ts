import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import type { ObjectStorage } from '../../integrations/objects/object-storage.js';
import { parseIdempotencyKey, type IdempotentResult } from '../../shared/idempotency.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import {
  addMyVehicle, getCourierOnboarding, getMyOnboarding, listRequirements, listReviewQueue,
  openDocument, reviewDocument, saveRequirement, setMyVehicleStatus, uploadMyDocument,
} from './onboarding.service.js';

const id = z.string().uuid();
const requirementSchema = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{1,49}$/),
  label: z.string().trim().min(2).max(120), description: z.string().trim().max(1000).nullable().optional(),
  required: z.boolean(), requiresReview: z.boolean(), requiresExpiry: z.boolean(), active: z.boolean(),
  sortOrder: z.number().int().min(0).max(10000),
});
const reviewSchema = z.object({ status: z.enum(['APPROVED', 'REJECTED']), notes: z.string().trim().min(3).max(1000) });
const vehicleSchema = z.object({
  typeLabel: z.string().trim().min(2).max(80), plate: z.string().trim().max(20).nullable().optional(),
  capacityKg: z.number().positive().max(100000).nullable().optional(), notes: z.string().trim().max(500).nullable().optional(),
});

function sendIdempotent<T>(reply: FastifyReply, result: IdempotentResult<T>) {
  reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false');
  return reply.status(result.statusCode).send(result.body);
}

export async function onboardingRoutes(
  app: FastifyInstance, database: Database, storage: ObjectStorage, env: AppEnv,
): Promise<void> {
  const auth = authenticate(env, database);
  app.get('/onboarding/me', { preHandler: [auth, requireRoles('COURIER')] },
    async (request) => getMyOnboarding(database, request.auth));
  app.get('/onboarding/couriers/:courierId', { preHandler: [auth, requireRoles('TENANT_MANAGER')] },
    async (request) => getCourierOnboarding(database, request.auth,
      id.parse((request.params as { courierId: string }).courierId)));
  app.get('/onboarding/requirements', { preHandler: auth },
    async (request) => listRequirements(database, request.auth));
  app.post('/onboarding/requirements', { preHandler: [auth, requireRoles('TENANT_MANAGER')] },
    async (request, reply) => reply.status(201).send(await saveRequirement(
      database, request.auth, requirementSchema.parse(request.body), undefined, request.ip)));
  app.patch('/onboarding/requirements/:requirementId', { preHandler: [auth, requireRoles('TENANT_MANAGER')] },
    async (request) => saveRequirement(database, request.auth, requirementSchema.parse(request.body),
      id.parse((request.params as { requirementId: string }).requirementId), request.ip));

  app.post('/onboarding/me/documents/:requirementId', { preHandler: [auth, requireRoles('COURIER')] },
    async (request, reply) => {
      const requirementId = id.parse((request.params as { requirementId: string }).requirementId);
      const expiresAt = z.string().date().optional().parse((request.query as { expiresAt?: string }).expiresAt);
      const file = await request.file({ limits: { files: 1, fileSize: env.PROOF_MAX_FILE_SIZE_BYTES, parts: 1 } });
      if (!file) return reply.status(400).send({ error: { code: 'FILE_REQUIRED', message: 'Envie um documento.' } });
      const result = await uploadMyDocument(database, storage, request.auth,
        parseIdempotencyKey(request.headers['idempotency-key']), requirementId,
        { buffer: await file.toBuffer(), mimeType: file.mimetype, expiresAt: expiresAt ?? null }, request.ip);
      return sendIdempotent(reply, result);
    });
  app.get('/onboarding/review-queue', { preHandler: [auth, requireRoles('TENANT_MANAGER')] },
    async (request) => listReviewQueue(database, request.auth));
  app.post('/onboarding/documents/:documentId/review', { preHandler: [auth, requireRoles('TENANT_MANAGER')] },
    async (request, reply) => sendIdempotent(reply, await reviewDocument(database, request.auth,
      parseIdempotencyKey(request.headers['idempotency-key']),
      id.parse((request.params as { documentId: string }).documentId), reviewSchema.parse(request.body), request.ip)));
  app.get('/onboarding/documents/:documentId/file', { preHandler: [auth, requireRoles('TENANT_MANAGER', 'COURIER')] },
    async (request, reply) => {
      const document = await openDocument(database, storage, request.auth,
        id.parse((request.params as { documentId: string }).documentId));
      reply.header('Cache-Control', 'private, no-store').header('Content-Disposition', 'inline').type(document.mimeType);
      return reply.send(document.stream);
    });
  app.post('/onboarding/me/vehicles', { preHandler: [auth, requireRoles('COURIER')] },
    async (request, reply) => reply.status(201).send(await addMyVehicle(
      database, request.auth, vehicleSchema.parse(request.body), request.ip)));
  app.patch('/onboarding/me/vehicles/:vehicleId/status', { preHandler: [auth, requireRoles('COURIER')] },
    async (request) => setMyVehicleStatus(database, request.auth,
      id.parse((request.params as { vehicleId: string }).vehicleId),
      z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) }).parse(request.body).status, request.ip));
}
