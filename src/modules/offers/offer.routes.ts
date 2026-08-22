import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { parseIdempotencyKey, type IdempotentResult } from '../../shared/idempotency.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import {
  acceptDeliveryOffer, cancelDeliveryOffer, createDeliveryOffer, listDeliveryOffers,
  listOfferFinancials, reviseDeliveryOfferPrice,
} from './offer.service.js';

const idSchema = z.object({ id: z.uuid() });
const statusSchema = z.object({
  status: z.enum(['PUBLISHED', 'ACCEPTED', 'COMPLETED', 'EXPIRED', 'CANCELLED']).optional(),
});
const createSchema = z.object({
  deliveryId: z.uuid(), payoutCents: z.number().int().positive(),
  estimatedDistanceM: z.number().int().positive(), estimatedDurationMinutes: z.number().int().positive().max(1440),
  pickupWindowStart: z.coerce.date(), pickupWindowEnd: z.coerce.date(), deliveryWindowEnd: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date(), searchRadiusM: z.number().int().min(500).max(100000).default(10000),
  volumeType: z.enum(['DOCUMENT', 'SMALL', 'MEDIUM', 'LARGE']).default('SMALL'),
  approximateRegion: z.string().trim().min(2).max(160).optional(),
  requirements: z.record(z.string(), z.unknown()).default({}),
}).refine((input) => input.pickupWindowEnd > input.pickupWindowStart, {
  path: ['pickupWindowEnd'], message: 'O fim da coleta deve ser posterior ao início.',
}).refine((input) => !input.deliveryWindowEnd || input.deliveryWindowEnd > input.pickupWindowStart, {
  path: ['deliveryWindowEnd'], message: 'O prazo de entrega deve ser posterior à coleta.',
});
const revisePriceSchema = z.object({
  payoutCents: z.number().int().positive(), reason: z.string().trim().min(3).max(500),
});
const cancelSchema = z.object({
  reason: z.string().trim().min(3).max(500), compensationCents: z.number().int().min(0).default(0),
});
const financialSchema = z.object({
  from: z.coerce.date().default(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1)),
  to: z.coerce.date().default(() => new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)),
}).refine((input) => input.to > input.from, { path: ['to'], message: 'O fim deve ser posterior ao início.' });

function keyFrom(request: FastifyRequest): string {
  return parseIdempotencyKey(request.headers['idempotency-key']);
}
function sendIdempotent<T>(reply: FastifyReply, result: IdempotentResult<T>) {
  reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false');
  return reply.status(result.statusCode).send(result.body);
}

export async function offerRoutes(app: FastifyInstance, database: Database, env: AppEnv): Promise<void> {
  const auth = authenticate(env, database);
  app.get('/delivery-offers', { preHandler: auth }, async (request) => {
    const { status } = statusSchema.parse(request.query);
    return listDeliveryOffers(database, request.auth, status);
  });
  app.post('/delivery-offers', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request, reply) => sendIdempotent(reply, await createDeliveryOffer(
    database, request.auth, keyFrom(request), createSchema.parse(request.body), request.ip,
  )));
  app.post('/delivery-offers/:id/accept', {
    preHandler: [auth, requireRoles('COURIER')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return sendIdempotent(reply, await acceptDeliveryOffer(database, request.auth, keyFrom(request), id, request.ip));
  });
  app.post('/delivery-offers/:id/revise-price', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return sendIdempotent(reply, await reviseDeliveryOfferPrice(
      database, request.auth, keyFrom(request), id, revisePriceSchema.parse(request.body), request.ip,
    ));
  });
  app.post('/delivery-offers/:id/cancel', { preHandler: auth }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return sendIdempotent(reply, await cancelDeliveryOffer(
      database, request.auth, keyFrom(request), id, cancelSchema.parse(request.body), request.ip,
    ));
  });
  app.get('/offer-financials', { preHandler: auth }, async (request) => {
    const { from, to } = financialSchema.parse(request.query);
    return listOfferFinancials(database, request.auth, from, to);
  });
}
