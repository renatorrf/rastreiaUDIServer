import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { parseIdempotencyKey, type IdempotentResult } from '../../shared/idempotency.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import {
  addDisputeEvidence, createMarketplaceBlock, listCourierReputation, listOfferDisputes,
  openOfferDispute, resolveOfferDispute, revokeMarketplaceBlock, startDisputeReview,
} from './reputation.service.js';

const idSchema = z.object({ id: z.uuid() });
const statusSchema = z.object({ status: z.enum(['OPEN', 'UNDER_REVIEW', 'RESOLVED']).optional() });
const evidenceSchema = z.object({
  evidenceType: z.enum(['NOTE', 'URL']), content: z.string().trim().min(3).max(2000),
}).refine((input) => input.evidenceType !== 'URL' || /^https?:\/\//i.test(input.content), {
  path: ['content'], message: 'Informe uma URL HTTP ou HTTPS válida.',
});
const openSchema = z.object({
  category: z.enum(['SERVICE', 'PUNCTUALITY', 'PAYMENT', 'CANCELLATION', 'CONDUCT', 'OTHER']),
  description: z.string().trim().min(10).max(2000), evidence: z.array(evidenceSchema).max(10).default([]),
});
const resolveSchema = z.object({
  outcome: z.enum(['STORE_FAVORED', 'COURIER_FAVORED', 'NO_FAULT', 'AGREEMENT', 'DISMISSED']),
  resolutionNotes: z.string().trim().min(10).max(2000),
});
const blockSchema = z.object({
  courierId: z.uuid(), storeId: z.uuid().nullable().optional(), reason: z.string().trim().min(10).max(500),
  activeUntil: z.coerce.date().nullable().optional(),
}).refine((input) => !input.activeUntil || input.activeUntil > new Date(), {
  path: ['activeUntil'], message: 'O fim do bloqueio deve estar no futuro.',
});
const revokeSchema = z.object({ reason: z.string().trim().min(3).max(500) });

function keyFrom(request: FastifyRequest): string { return parseIdempotencyKey(request.headers['idempotency-key']); }
function sendIdempotent<T>(reply: FastifyReply, result: IdempotentResult<T>) {
  reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false');
  return reply.status(result.statusCode).send(result.body);
}

export async function reputationRoutes(app: FastifyInstance, database: Database, env: AppEnv): Promise<void> {
  const auth = authenticate(env, database);
  app.get('/offer-disputes', { preHandler: auth }, async (request) => {
    const { status } = statusSchema.parse(request.query);
    return listOfferDisputes(database, request.auth, status);
  });
  app.post('/delivery-offers/:id/disputes', { preHandler: auth }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return sendIdempotent(reply, await openOfferDispute(
      database, request.auth, keyFrom(request), id, openSchema.parse(request.body), request.ip,
    ));
  });
  app.post('/offer-disputes/:id/evidence', { preHandler: auth }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return sendIdempotent(reply, await addDisputeEvidence(
      database, request.auth, keyFrom(request), id, evidenceSchema.parse(request.body), request.ip,
    ));
  });
  app.post('/offer-disputes/:id/review', {
    preHandler: [auth, requireRoles('TENANT_MANAGER')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return sendIdempotent(reply, await startDisputeReview(database, request.auth, keyFrom(request), id, request.ip));
  });
  app.post('/offer-disputes/:id/resolve', {
    preHandler: [auth, requireRoles('TENANT_MANAGER')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return sendIdempotent(reply, await resolveOfferDispute(
      database, request.auth, keyFrom(request), id, resolveSchema.parse(request.body), request.ip,
    ));
  });
  app.get('/courier-reputation', { preHandler: auth }, async (request) => listCourierReputation(database, request.auth));
  app.post('/courier-marketplace-blocks', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request, reply) => sendIdempotent(reply, await createMarketplaceBlock(
    database, request.auth, keyFrom(request), blockSchema.parse(request.body), request.ip,
  )));
  app.post('/courier-marketplace-blocks/:id/revoke', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const { reason } = revokeSchema.parse(request.body);
    return sendIdempotent(reply, await revokeMarketplaceBlock(
      database, request.auth, keyFrom(request), id, reason, request.ip,
    ));
  });
}
