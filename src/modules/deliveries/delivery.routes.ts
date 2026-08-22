import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { parseIdempotencyKey, type IdempotentResult } from '../../shared/idempotency.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import {
  assignDelivery, createDelivery, getDelivery, listDeliveries, transitionDelivery,
} from './delivery.service.js';
import { deliveryStatuses } from './delivery.types.js';

const deliveryIdSchema = z.object({ id: z.uuid() });
const createDeliverySchema = z.object({
  storeId: z.uuid(),
  externalReference: z.string().trim().max(100).nullable().optional(),
  recipientName: z.string().trim().min(2).max(160),
  recipientPhone: z.string().trim().min(8).max(30),
  recipientWhatsapp: z.string().trim().min(8).max(30).nullable().optional(),
  addressLine: z.string().trim().min(3).max(240),
  addressNumber: z.string().trim().max(30).nullable().optional(),
  complement: z.string().trim().max(120).nullable().optional(),
  neighborhood: z.string().trim().max(120).nullable().optional(),
  city: z.string().trim().min(2).max(120),
  state: z.string().trim().length(2).toUpperCase(),
  postalCode: z.string().trim().max(12).nullable().optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  addressConfidence: z.number().min(0).max(1).nullable().optional(),
  deliveryInstructions: z.string().trim().max(1000).nullable().optional(),
  promisedWindowStart: z.coerce.date().nullable().optional(),
  promisedWindowEnd: z.coerce.date().nullable().optional(),
}).refine(
  (input) => !input.promisedWindowStart || !input.promisedWindowEnd || input.promisedWindowEnd > input.promisedWindowStart,
  { path: ['promisedWindowEnd'], message: 'O fim da janela deve ser posterior ao início.' },
);

const assignSchema = z.object({ courierId: z.uuid() });
const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const listSchema = z.object({
  status: z.enum(deliveryStatuses).optional(),
  storeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function keyFrom(request: FastifyRequest): string {
  return parseIdempotencyKey(request.headers['idempotency-key']);
}

function sendIdempotent<T>(reply: FastifyReply, result: IdempotentResult<T>) {
  reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false');
  return reply.status(result.statusCode).send(result.body);
}

export async function deliveryRoutes(app: FastifyInstance, database: Database, env: AppEnv): Promise<void> {
  const auth = authenticate(env, database);

  app.get('/deliveries', { preHandler: auth }, async (request) => {
    const filters = listSchema.parse(request.query);
    return listDeliveries(database, request.auth, filters);
  });

  app.get('/deliveries/:id', { preHandler: auth }, async (request) => {
    const { id } = deliveryIdSchema.parse(request.params);
    return getDelivery(database, request.auth, id);
  });

  app.post('/deliveries', { preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')] }, async (request, reply) => {
    const input = createDeliverySchema.parse(request.body);
    const result = await createDelivery(database, request.auth, keyFrom(request), input, request.ip);
    return sendIdempotent(reply, result);
  });

  app.post('/deliveries/:id/assign', { preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')] }, async (request, reply) => {
    const { id } = deliveryIdSchema.parse(request.params);
    const { courierId } = assignSchema.parse(request.body);
    const result = await assignDelivery(database, request.auth, keyFrom(request), id, courierId, request.ip);
    return sendIdempotent(reply, result);
  });

  for (const action of ['collect', 'start', 'complete'] as const) {
    app.post(`/deliveries/:id/${action}`, { preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR', 'COURIER')] }, async (request, reply) => {
      const { id } = deliveryIdSchema.parse(request.params);
      const result = await transitionDelivery(database, request.auth, keyFrom(request), id, action, undefined, request.ip);
      return sendIdempotent(reply, result);
    });
  }

  app.post('/deliveries/:id/fail', { preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR', 'COURIER')] }, async (request, reply) => {
    const { id } = deliveryIdSchema.parse(request.params);
    const { reason } = reasonSchema.parse(request.body);
    const result = await transitionDelivery(database, request.auth, keyFrom(request), id, 'fail', reason, request.ip);
    return sendIdempotent(reply, result);
  });

  app.post('/deliveries/:id/cancel', { preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')] }, async (request, reply) => {
    const { id } = deliveryIdSchema.parse(request.params);
    const { reason } = reasonSchema.parse(request.body);
    const result = await transitionDelivery(database, request.auth, keyFrom(request), id, 'cancel', reason, request.ip);
    return sendIdempotent(reply, result);
  });
}
