import crypto from 'node:crypto';
import {
  ROOT_CONTEXT, SpanKind, SpanStatusCode, isSpanContextValid, propagation, trace, type Span,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { AppEnv } from '../config/env.js';
import type { Database } from '../database/pool.js';
import type { RedisRuntime } from '../infrastructure/redis/redis-runtime.js';

interface RequestTelemetry {
  span: Span;
  startedAt: bigint;
}

interface TelemetryDependencies {
  database: Database;
  redis: RedisRuntime;
  realtimeStatus: () => 'redis' | 'local';
}

const requestTelemetry = new WeakMap<FastifyRequest, RequestTelemetry>();
let telemetrySdk: NodeSDK | undefined;

function bearerMatches(value: string | undefined, expected: string): boolean {
  const match = value?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!match || !expected) return false;
  const candidate = Buffer.from(match);
  const secret = Buffer.from(expected);
  return candidate.length === secret.length && crypto.timingSafeEqual(candidate, secret);
}

function routeLabel(request: FastifyRequest): string {
  const route = request.routeOptions.url;
  return typeof route === 'string' && route.length <= 160 ? route : 'unmatched';
}

export async function startTraceExport(env: AppEnv): Promise<void> {
  if (!env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || telemetrySdk) return;
  telemetrySdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME,
    traceExporter: new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }),
    logRecordProcessors: [],
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(env.OTEL_TRACE_SAMPLE_RATIO),
    }),
  });
  telemetrySdk.start();
}

export async function stopTraceExport(): Promise<void> {
  if (!telemetrySdk) return;
  const current = telemetrySdk;
  telemetrySdk = undefined;
  await current.shutdown();
}

export function markRequestError(request: FastifyRequest, code: string): void {
  const current = requestTelemetry.get(request);
  if (!current) return;
  current.span.setAttribute('error.type', code.slice(0, 80));
  current.span.setStatus({ code: SpanStatusCode.ERROR });
}

export async function registerTelemetry(
  app: FastifyInstance,
  env: AppEnv,
  dependencies: TelemetryDependencies,
): Promise<void> {
  await startTraceExport(env);
  const registry = new Registry();
  registry.setDefaultLabels({ service: env.OTEL_SERVICE_NAME, environment: env.DEPLOYMENT_ENVIRONMENT });
  collectDefaultMetrics({ prefix: 'rastreia_', register: registry });

  const requests = new Counter({
    name: 'rastreia_http_requests_total',
    help: 'Total de requisições HTTP concluídas.',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'rastreia_http_request_duration_seconds',
    help: 'Duração das requisições HTTP em segundos.',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const dependencyUp = new Gauge({
    name: 'rastreia_dependency_up',
    help: 'Disponibilidade das dependências críticas (1 disponível, 0 indisponível).',
    labelNames: ['dependency'] as const,
    registers: [registry],
  });
  const queueDepth = new Gauge({
    name: 'rastreia_outbox_events',
    help: 'Quantidade global de eventos por estado do outbox.',
    labelNames: ['state'] as const,
    registers: [registry],
  });
  const oldestPending = new Gauge({
    name: 'rastreia_outbox_oldest_pending_age_seconds',
    help: 'Idade em segundos do evento pendente mais antigo.',
    registers: [registry],
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
    const parent = propagation.extract(ROOT_CONTEXT, request.headers);
    const span = trace.getTracer(env.OTEL_SERVICE_NAME).startSpan(
      `HTTP ${request.method}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.request.method': request.method,
          'server.address': request.hostname,
          'deployment.environment.name': env.DEPLOYMENT_ENVIRONMENT,
        },
      },
      parent,
    );
    requestTelemetry.set(request, { span, startedAt: process.hrtime.bigint() });
    const correlatedLogger = request.log as unknown as {
      setBindings: (bindings: Record<string, string>) => void;
    };
    const spanContext = span.spanContext();
    correlatedLogger.setBindings({
      requestId: request.id,
      correlation_id: request.id,
      app_version: env.RELEASE_VERSION,
      ...(process.env['K_REVISION'] ? { cloud_run_revision: process.env['K_REVISION'] } : {}),
      ...(isSpanContextValid(spanContext) ? { traceId: spanContext.traceId } : {}),
    });
  });

  app.addHook('onResponse', async (request, reply) => {
    const current = requestTelemetry.get(request);
    if (!current) return;
    const route = routeLabel(request);
    const statusCode = String(reply.statusCode);
    const labels = { method: request.method, route, status_code: statusCode };
    requests.inc(labels);
    duration.observe(labels, Number(process.hrtime.bigint() - current.startedAt) / 1_000_000_000);
    current.span.setAttributes({
      'http.route': route,
      'http.response.status_code': reply.statusCode,
    });
    if (reply.statusCode >= 500) current.span.setStatus({ code: SpanStatusCode.ERROR });
    else current.span.setStatus({ code: SpanStatusCode.OK });
    current.span.end();
    requestTelemetry.delete(request);
  });

  app.get('/internal/metrics', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, env.METRICS_BEARER_TOKEN)) {
      return reply.header('X-Correlation-Id',request.id).status(404).send({
        error: { code: 'NOT_FOUND', message: 'Rota não encontrada.', correlation_id: request.id },
      });
    }
    reply.header('Cache-Control', 'no-store');
    let postgresUp = 0;
    try {
      const result = await dependencies.database.query<{
        pending: number;
        retrying: number;
        dead_letters: number;
        oldest_age: number;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM rastreia.outbox_events WHERE processed_at IS NULL) AS pending,
           (SELECT count(*)::integer FROM rastreia.outbox_events
            WHERE processed_at IS NULL AND attempts > 0) AS retrying,
           (SELECT count(*)::integer FROM rastreia.outbox_dead_letters
            WHERE replayed_at IS NULL) AS dead_letters,
           COALESCE((SELECT extract(epoch FROM now() - min(occurred_at))
                     FROM rastreia.outbox_events WHERE processed_at IS NULL), 0)::double precision AS oldest_age`,
      );
      const row = result.rows[0]!;
      queueDepth.set({ state: 'pending' }, row.pending);
      queueDepth.set({ state: 'retrying' }, row.retrying);
      queueDepth.set({ state: 'dead_letter' }, row.dead_letters);
      oldestPending.set(row.oldest_age);
      postgresUp = 1;
    } catch {
      queueDepth.reset();
      oldestPending.set(0);
    }
    dependencyUp.set({ dependency: 'postgres' }, postgresUp);
    dependencyUp.set({ dependency: 'redis' }, dependencies.redis.status === 'ready' ? 1 : 0);
    dependencyUp.set({ dependency: 'realtime_cluster' }, dependencies.realtimeStatus() === 'redis' ? 1 : 0);
    return reply.header('Content-Type', registry.contentType).send(await registry.metrics());
  });
}
