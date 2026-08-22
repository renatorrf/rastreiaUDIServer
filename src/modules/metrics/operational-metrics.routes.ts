import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import {
  auditOperationalMetricsExport, getOperationalMetrics, operationalMetricsCsv,
} from './operational-metrics.service.js';

const metricsQuerySchema = z.object({
  from: z.coerce.date().optional(), to: z.coerce.date().optional(),
  storeId: z.uuid().optional(), courierId: z.uuid().optional(),
}).superRefine((value, context) => {
  if (value.from && value.to && value.from >= value.to) {
    context.addIssue({ code: 'custom', path: ['to'], message: 'O fim do período deve ser posterior ao início.' });
  }
  if (value.from && value.to && value.to.getTime() - value.from.getTime() > 366 * 24 * 60 * 60_000) {
    context.addIssue({ code: 'custom', path: ['to'], message: 'O período máximo é de 366 dias.' });
  }
});

export async function operationalMetricsRoutes(app: FastifyInstance, database: Database, env: AppEnv): Promise<void> {
  const auth = authenticate(env, database);
  const management = [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')];
  app.get('/operational-metrics', { preHandler: management }, async (request) =>
    getOperationalMetrics(database, request.auth, metricsQuerySchema.parse(request.query)));
  app.get('/operational-metrics/export', { preHandler: management }, async (request, reply) => {
    const report = await getOperationalMetrics(database, request.auth, metricsQuerySchema.parse(request.query));
    await auditOperationalMetricsExport(database, request.auth, report, request.ip);
    const date = report.scope.generatedAt.slice(0, 10);
    return reply.header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="rastreia-indicadores-${date}.csv"`)
      .send(operationalMetricsCsv(report));
  });
}
