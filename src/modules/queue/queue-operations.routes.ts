import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import { getQueueHealth, listDeadLetters, replayDeadLetter } from './queue-operations.service.js';

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) });
const idParams = z.object({ id: z.uuid() });

export async function queueOperationsRoutes(app: FastifyInstance, database: Database, env: AppEnv): Promise<void> {
  const management = [authenticate(env, database), requireRoles('TENANT_MANAGER')];
  app.get('/operations/queue-health', { preHandler: management }, async (request) =>
    getQueueHealth(database, request.auth));
  app.get('/operations/dead-letters', { preHandler: management }, async (request) => {
    const { limit } = listQuery.parse(request.query);
    return listDeadLetters(database, request.auth, limit);
  });
  app.post('/operations/dead-letters/:id/replay', { preHandler: management }, async (request) => {
    const { id } = idParams.parse(request.params);
    return replayDeadLetter(database, request.auth, id, request.ip);
  });
}
