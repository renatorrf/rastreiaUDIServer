import crypto from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { ZodError } from 'zod';
import type { AppEnv } from './config/env.js';
import { getEnv } from './config/env.js';
import { createPool, type Database } from './database/pool.js';
import { createRedisRuntime, type RedisRuntime } from './infrastructure/redis/redis-runtime.js';
import { GeoapifyProvider } from './integrations/geo/geoapify.provider.js';
import type { RouteDirectionsProvider, RouteMatrixProvider } from './integrations/geo/geo-provider.js';
import { geoRoutes } from './integrations/geo/geo.routes.js';
import { ifoodRoutes } from './integrations/ifood/ifood.routes.js';
import { createObjectStorage } from './integrations/objects/object-storage.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { identityRoutes } from './modules/auth/identity.routes.js';
import { courierAccountRoutes } from './modules/couriers/courier-account.routes.js';
import { platformUnitRoutes } from './modules/platform/platform-units.routes.js';
import { billingRoutes } from './modules/billing/billing.routes.js';
import { organizationRoutes } from './modules/organization/organization.routes.js';
import { organizationOperationsRoutes } from './modules/organization/operations.routes.js';
import { courierRoutes } from './modules/couriers/courier.routes.js';
import { communicationRoutes } from './modules/communications/communication.routes.js';
import { communicationWebhookRoutes } from './modules/communications/webhook.routes.js';
import { deliveryRoutes } from './modules/deliveries/delivery.routes.js';
import { locationRoutes } from './modules/locations/location.routes.js';
import { workdayRoutes } from './modules/workdays/workday.routes.js';
import { incidentRoutes } from './modules/incidents/incident.routes.js';
import { driverEventRoutes } from './modules/driver-events/driver-event.routes.js';
import { onboardingRoutes } from './modules/onboarding/onboarding.routes.js';
import { RedisLocationStateStore } from './modules/locations/location-state.store.js';
import { operationalMetricsRoutes } from './modules/metrics/operational-metrics.routes.js';
import { offerRoutes } from './modules/offers/offer.routes.js';
import { platformRoutes } from './modules/platform/platform.routes.js';
import { proofRoutes } from './modules/proofs/proof.routes.js';
import { queueOperationsRoutes } from './modules/queue/queue-operations.routes.js';
import { reputationRoutes } from './modules/reputation/reputation.routes.js';
import { routeRoutes } from './modules/routes/route.routes.js';
import { shiftRoutes } from './modules/shifts/shift.routes.js';
import { storeRoutes } from './modules/stores/store.routes.js';
import { tenantRoutes } from './modules/tenants/tenant.routes.js';
import { trackingRoutes } from './modules/tracking/tracking.routes.js';
import { userRoutes } from './modules/users/user.routes.js';
import { AppError } from './shared/errors.js';
import { createLocationRealtime } from './realtime/location-realtime.js';
import { markRequestError, registerTelemetry, stopTraceExport } from './telemetry/telemetry.js';

interface BuildAppOptions {
  env?: AppEnv;
  database?: Database;
  routeMatrixProvider?: RouteMatrixProvider;
  routeDirectionsProvider?: RouteDirectionsProvider;
  redisRuntime?: RedisRuntime;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const env = options.env ?? getEnv();
  const database = options.database ?? createPool(env);
  const allowedOrigins = new Set(env.APP_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean));
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-master-login-grant"]',
        'res.headers.set-cookie', '*.password', '*.token', '*.grant', '*.apiKey'],
      serializers: {
        req(request) {
          const url = typeof request.url === 'string' && request.url.startsWith('/public/tracking/')
            ? '/public/tracking/[redacted]'
            : request.url;
          return { method: request.method, url, host: request.host };
        },
      },
    },
    trustProxy: true,
    bodyLimit: 1_048_576,
    genReqId(request) {
      const candidate = request.headers['x-request-id'];
      return typeof candidate === 'string' && /^[A-Za-z0-9._-]{8,80}$/.test(candidate)
        ? candidate
        : crypto.randomUUID();
    },
  });

  app.decorateRequest('auth');
  app.decorateRequest('platformAuth');
  await app.register(cookie);
  await app.register(multipart, {
    limits: { files: 1, fileSize: env.PROOF_MAX_FILE_SIZE_BYTES ?? 5_242_880, fields: 0, parts: 1 },
  });
  await app.register(rawBody, { global: false, encoding: false, runFirst: true });
  await app.register(cors, {
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      else callback(new Error('Origem não permitida.'), false);
    },
  });
  await app.register(helmet);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  const redis = options.redisRuntime ?? await createRedisRuntime(env, (level, message, details) => {
    app.log[level](details ?? {}, message);
  });
  const locationState = new RedisLocationStateStore(
    redis, env.REDIS_LOCATION_TTL_SECONDS, env.REDIS_PRESENCE_TTL_SECONDS,
  );
  let realtimeStatus: () => 'redis' | 'local' = () => 'local';
  await registerTelemetry(app, env, { database, redis, realtimeStatus: () => realtimeStatus() });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/version', async () => ({
    version: env.RELEASE_VERSION,
    commit: env.RELEASE_COMMIT,
    environment: env.DEPLOYMENT_ENVIRONMENT,
  }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await database.query('SELECT 1');
      const redisStatus = redis.status === 'ready' && !await redis.ping() ? 'unavailable' : redis.status;
      if (redisStatus === 'unavailable' && redis.isRequired) {
        return reply.status(503).send({
          status: 'unavailable', dependencies: { postgres: 'ready', redis: redisStatus, realtime: realtimeStatus() },
        });
      }
      return {
        status: redisStatus === 'unavailable' ? 'degraded' : 'ready',
        dependencies: { postgres: 'ready', redis: redisStatus, realtime: realtimeStatus() },
      };
    } catch {
      return reply.status(503).send({
        status: 'unavailable', dependencies: { postgres: 'unavailable', redis: redis.status, realtime: realtimeStatus() },
      });
    }
  });

  const geoapify = new GeoapifyProvider(env.GEOAPIFY_API_KEY);
  const objectStorage = env.OBJECT_STORAGE_PROVIDER
    ? createObjectStorage(env)
    : createObjectStorage({ ...env, OBJECT_STORAGE_PROVIDER: 'local',
        OBJECT_STORAGE_PATH: '.data/objects' });
  const realtime = await createLocationRealtime(
    app.server, database, env, [...allowedOrigins], redis, locationState,
  );
  realtimeStatus = realtime.status;
  await authRoutes(app, database, env);
  await identityRoutes(app, database, env);
  await courierAccountRoutes(app, database, env);
  await platformUnitRoutes(app, database, env);
  await organizationRoutes(app, database, env);
  await organizationOperationsRoutes(app, database, env);
  await billingRoutes(app, database, env);
  await platformRoutes(app, database, env);
  await tenantRoutes(app, database, env);
  await storeRoutes(app, database, env);
  await userRoutes(app, database, env);
  await courierRoutes(app, database, env);
  await communicationRoutes(app, database, env);
  await communicationWebhookRoutes(app, database, env);
  await deliveryRoutes(app, database, env);
  await offerRoutes(app, database, env);
  await reputationRoutes(app, database, env);
  await routeRoutes(app, database, env, options.routeMatrixProvider ?? geoapify,
    options.routeDirectionsProvider ?? geoapify);
  await trackingRoutes(app, database, env, locationState);
  await locationRoutes(app, database, env, realtime.publisher, locationState);
  await workdayRoutes(app, database, env, realtime.publisher);
  await operationalMetricsRoutes(app, database, env);
  await proofRoutes(app, database, objectStorage, env);
  await incidentRoutes(app, database, objectStorage, env);
  await driverEventRoutes(app, database, env, realtime.publisher);
  await onboardingRoutes(app, database, objectStorage, env);
  await queueOperationsRoutes(app, database, env);
  await shiftRoutes(app, database, env);
  await geoRoutes(app, env, database, geoapify, geoapify);
  await ifoodRoutes(app, database, env);

  app.setNotFoundHandler(async (_request, reply) => reply.status(404).send({
    error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' },
  }));

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof Error && error.message === 'MASTER_REQUIRED') {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Somente o Master pode alterar unidades.' } });
    }
    if (error instanceof Error && error.message === 'UNIT_UNAVAILABLE') {
      return reply.status(409).send({ error: { code: 'UNIT_UNAVAILABLE',
        message: 'A unidade está temporariamente indisponível para novas operações.' } });
    }
    if (error instanceof ZodError) {
      markRequestError(request, 'VALIDATION_ERROR');
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Revise os campos informados.',
          details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      });
    }
    if (error instanceof AppError) {
      if (error.statusCode >= 500) markRequestError(request, error.code);
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    if ((error as { code?: string }).code === '23505') {
      return reply.status(409).send({ error: { code: 'CONFLICT', message: 'Já existe um registro com a mesma referência.' } });
    }
    markRequestError(request, 'INTERNAL_ERROR');
    request.log.error({
      errorType: error instanceof Error ? error.name : 'UnknownError',
      errorCode: typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined,
      errorMessage: env.NODE_ENV === 'production' || !(error instanceof Error) ? undefined : error.message,
    }, 'Erro não tratado');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' } });
  });

  app.addHook('onClose', async () => {
    await realtime.close();
    await redis.close();
    await database.end();
    await stopTraceExport();
  });
  return app;
}
