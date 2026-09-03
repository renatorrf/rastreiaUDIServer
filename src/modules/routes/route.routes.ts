import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import type { RouteDirectionsProvider, RouteMatrixProvider } from '../../integrations/geo/geo-provider.js';
import { parseIdempotencyKey, type IdempotentResult } from '../../shared/idempotency.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import {
  applyRouteSuggestion, completeRouteStop, createRoute, getRouteNavigation, listRoutes, optimizeRoute,
  reorderRoute, startRoute,
} from './route.service.js';

const routeIdSchema = z.object({ id: z.uuid() });
const stopIdSchema = z.object({ id: z.uuid(), stopId: z.uuid() });
const createSchema = z.object({
  storeId: z.uuid(), courierId: z.uuid(), deliveryIds: z.array(z.uuid()).min(2).max(50),
  label: z.string().trim().min(3).max(120), plannedStartAt: z.coerce.date().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
}).refine((input) => new Set(input.deliveryIds).size === input.deliveryIds.length, {
  path: ['deliveryIds'], message: 'Não repita entregas no lote.',
});
const reorderSchema = z.object({ stopIds: z.array(z.uuid()).min(4).max(100) });

function keyFrom(request: FastifyRequest): string { return parseIdempotencyKey(request.headers['idempotency-key']); }
function sendIdempotent<T>(reply: FastifyReply, result: IdempotentResult<T>) {
  reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false');
  return reply.status(result.statusCode).send(result.body);
}

export async function routeRoutes(
  app: FastifyInstance, database: Database, env: AppEnv, matrixProvider: RouteMatrixProvider,
  directionsProvider: RouteDirectionsProvider,
): Promise<void> {
  const auth = authenticate(env, database);
  app.get('/routes', { preHandler: auth }, async (request) => listRoutes(database, request.auth));
  app.get('/routes/:id/navigation', { preHandler: auth }, async (request) => {
    const { id } = routeIdSchema.parse(request.params);
    return getRouteNavigation(database, request.auth, id, directionsProvider);
  });
  app.post('/routes', { preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')] },
    async (request, reply) => sendIdempotent(reply, await createRoute(
      database, request.auth, keyFrom(request), createSchema.parse(request.body), request.ip,
    )));
  app.post('/routes/:id/reorder', { preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')] },
    async (request, reply) => {
      const { id } = routeIdSchema.parse(request.params); const { stopIds } = reorderSchema.parse(request.body);
      return sendIdempotent(reply, await reorderRoute(database, request.auth, keyFrom(request), id, stopIds, request.ip));
    });
  app.post('/routes/:id/start', { preHandler: auth }, async (request, reply) => {
    const { id } = routeIdSchema.parse(request.params);
    return sendIdempotent(reply, await startRoute(database, request.auth, keyFrom(request), id, request.ip));
  });
  app.post('/routes/:id/optimize', { preHandler: auth },
    async (request, reply) => { const { id } = routeIdSchema.parse(request.params);
      return sendIdempotent(reply, await optimizeRoute(
        database, request.auth, keyFrom(request), id, matrixProvider, request.ip,
      )); });
  app.post('/routes/:id/apply-suggestion', { preHandler: auth },
    async (request, reply) => { const { id } = routeIdSchema.parse(request.params);
      return sendIdempotent(reply, await applyRouteSuggestion(
        database, request.auth, keyFrom(request), id, request.ip,
      )); });
  app.post('/routes/:id/stops/:stopId/complete', { preHandler: auth }, async (request, reply) => {
    const { id, stopId } = stopIdSchema.parse(request.params);
    return sendIdempotent(reply, await completeRouteStop(
      database, request.auth, keyFrom(request), id, stopId, request.ip,
    ));
  });
}
