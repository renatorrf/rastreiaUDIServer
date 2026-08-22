import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { AppError } from '../../shared/errors.js';
import { parseIdempotencyKey, type IdempotentResult } from '../../shared/idempotency.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import {
  createBackgroundTrackingSession, ingestBackgroundLocation, revokeBackgroundTrackingSession,
} from './background-tracking.service.js';
import { ingestLocations, listActiveLocations } from './location.service.js';
import type { LocationStateStore } from './location-state.store.js';
import type { LocationPointInput, LocationPublisher } from './location.types.js';

const pointSchema = z.object({
  eventId: z.uuid(),
  deliveryId: z.uuid(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().positive().max(1000),
  speed: z.number().min(0).max(100).nullable().optional(),
  heading: z.number().min(0).max(360).nullable().optional(),
  altitude: z.number().min(-500).max(20_000).nullable().optional(),
  capturedAt: z.coerce.date(),
});
const batchSchema = z.object({ points: z.array(pointSchema).min(1).max(100) });
const backgroundSessionSchema = z.object({
  deliveryId: z.uuid(),
  platform: z.enum(['android', 'ios']),
});
const backgroundSessionParams = z.object({ id: z.uuid() });
const nativePointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().positive().max(1000),
  altitude: z.number().min(-500).max(20_000).nullable().optional(),
  bearing: z.number().min(-1).max(360).nullable().optional(),
  speed: z.number().min(-1).max(100).nullable().optional(),
  time: z.number().int().positive(),
  source: z.literal('native').optional(),
}).passthrough();

function bearerToken(value: string | undefined): string {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw new AppError(401, 'UNAUTHORIZED', 'Sessão de rastreamento inválida.');
  return match[1];
}

function sendIdempotent<T>(reply: FastifyReply, result: IdempotentResult<T>) {
  reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false');
  return reply.status(result.statusCode).send(result.body);
}

export async function locationRoutes(
  app: FastifyInstance,
  database: Database,
  env: AppEnv,
  publisher: LocationPublisher,
  state: LocationStateStore,
): Promise<void> {
  const auth = authenticate(env, database);
  const courierOnly = [auth, requireRoles('COURIER')];

  app.post('/courier/location', { preHandler: courierOnly }, async (request, reply) => {
    const point: LocationPointInput = pointSchema.parse(request.body);
    const result = await ingestLocations(database, publisher, request.auth,
      parseIdempotencyKey(request.headers['idempotency-key']), [point], 'single');
    return sendIdempotent(reply, result);
  });

  app.post('/courier/location/batch', { preHandler: courierOnly }, async (request, reply) => {
    const input: { points: LocationPointInput[] } = batchSchema.parse(request.body);
    const result = await ingestLocations(database, publisher, request.auth,
      parseIdempotencyKey(request.headers['idempotency-key']), input.points, 'batch');
    return sendIdempotent(reply, result);
  });

  app.post('/courier/background-tracking-sessions', { preHandler: courierOnly }, async (request, reply) => {
    const input = backgroundSessionSchema.parse(request.body);
    const session = await createBackgroundTrackingSession(
      database, env, request.auth, input.deliveryId, input.platform, request.ip,
    );
    return reply.status(201).send(session);
  });

  app.delete('/courier/background-tracking-sessions/:id', { preHandler: courierOnly }, async (request) => {
    const { id } = backgroundSessionParams.parse(request.params);
    return revokeBackgroundTrackingSession(database, request.auth, id, request.ip);
  });

  app.post('/mobile/location', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const input = nativePointSchema.parse(request.body);
    const result = await ingestBackgroundLocation(
      database, publisher, env, bearerToken(request.headers.authorization), input,
    );
    return reply.status(202).send(result);
  });

  app.get('/locations/active', { preHandler: auth }, async (request) =>
    listActiveLocations(database, request.auth, state));
}
