import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { parseIdempotencyKey, type IdempotentResult } from '../../shared/idempotency.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import {
  getPushStatus, listDeliveryMessages, queueTrackingMessage,
  getPushSubscriptionStatus, queuePushTest, removePushSubscription, savePushSubscription,
} from './communication.service.js';

const subscriptionSchema = z.object({
  endpoint: z.url().max(4096),
  expirationTime: z.coerce.date().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(20).max(512), auth: z.string().min(8).max(256) }),
});
const removeSchema = z.object({ endpoint: z.url().max(4096) });
const deliveryIdSchema = z.object({ id: z.uuid() });
const channelSchema = z.object({ channel: z.enum(['WHATSAPP', 'SMS']) });

function sendIdempotent<T>(reply: FastifyReply, result: IdempotentResult<T>) {
  reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false');
  return reply.status(result.statusCode).send(result.body);
}

export async function communicationRoutes(app: FastifyInstance, database: Database, env: AppEnv): Promise<void> {
  const auth = authenticate(env, database);

  app.get('/push/status', { preHandler: auth }, async (request) =>
    getPushStatus(database, request.auth, env));

  app.put('/push/subscriptions', { preHandler: auth }, async (request) => {
    const input = subscriptionSchema.parse(request.body);
    return savePushSubscription(database, request.auth, input, request.headers['user-agent']);
  });

  app.post('/push/subscriptions/status', { preHandler: auth }, async (request) => {
    const input = removeSchema.parse(request.body);
    return getPushSubscriptionStatus(database,request.auth,input.endpoint);
  });

  app.post('/push/test', { preHandler: auth }, async (request,reply) =>
    sendIdempotent(reply,await queuePushTest(database,request.auth,parseIdempotencyKey(request.headers['idempotency-key']))));

  app.delete('/push/subscriptions', { preHandler: auth }, async (request) => {
    const input = removeSchema.parse(request.body);
    return removePushSubscription(database, request.auth, input.endpoint);
  });

  app.post('/deliveries/:id/tracking-message', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = deliveryIdSchema.parse(request.params);
    const { channel } = channelSchema.parse(request.body);
    const result = await queueTrackingMessage(database, env, request.auth,
      parseIdempotencyKey(request.headers['idempotency-key']), id, channel, request.ip);
    return sendIdempotent(reply, result);
  });

  app.get('/deliveries/:id/messages', { preHandler: auth }, async (request) => {
    const { id } = deliveryIdSchema.parse(request.params);
    return listDeliveryMessages(database, request.auth, id);
  });
}
