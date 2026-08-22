import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { notFound } from '../../shared/errors.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import type { LocationStateStore } from '../locations/location-state.store.js';
import { getPublicTracking, issueTrackingLink, revokeTrackingLink } from './tracking.service.js';
import { trackingTokenHash } from './tracking-token.js';

const deliveryIdSchema = z.object({ id: z.uuid() });
const publicTokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export async function trackingRoutes(
  app: FastifyInstance,
  database: Database,
  env: AppEnv,
  state: LocationStateStore,
): Promise<void> {
  const auth = authenticate(env, database);

  app.post('/deliveries/:id/tracking-link', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request) => {
    const { id } = deliveryIdSchema.parse(request.params);
    return issueTrackingLink(database, env, request.auth, id, request.ip);
  });

  app.post('/deliveries/:id/tracking-link/revoke', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request) => {
    const { id } = deliveryIdSchema.parse(request.params);
    return revokeTrackingLink(database, request.auth, id, request.ip);
  });

  app.get('/public/tracking/:token', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (request: FastifyRequest) => {
          const candidate = (request.params as { token?: string }).token ?? '';
          return `${request.ip}:${trackingTokenHash(candidate, env.TRACKING_TOKEN_PEPPER)}`;
        },
      },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    const parsed = publicTokenSchema.safeParse(request.params);
    if (!parsed.success) throw notFound('Acompanhamento indisponível.');
    return getPublicTracking(database, env, state, parsed.data.token, request.ip);
  });
}
