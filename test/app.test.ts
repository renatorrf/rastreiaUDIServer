import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { RedisRuntime } from '../src/infrastructure/redis/redis-runtime.js';

const env = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 3000,
  DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
  APP_ORIGINS: 'http://localhost:8100',
  LOG_LEVEL: 'silent',
  DEPLOYMENT_ENVIRONMENT: 'test',
  RELEASE_VERSION: 'test',
  RELEASE_COMMIT: 'test-commit',
  METRICS_BEARER_TOKEN: 'metrics-token-with-more-than-32-characters',
  OTEL_SERVICE_NAME: 'rastreia-backend-test',
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
  OTEL_TRACE_SAMPLE_RATIO: 1,
  REDIS_URL: '',
  REDIS_REQUIRED: false,
  REDIS_KEY_PREFIX: 'rastreia-test',
  REDIS_CONNECT_TIMEOUT_MS: 250,
  REDIS_LOCATION_TTL_SECONDS: 900,
  REDIS_PRESENCE_TTL_SECONDS: 120,
  JWT_ACCESS_SECRET: 'access-secret-with-more-than-thirty-two-characters',
  JWT_REFRESH_SECRET: 'refresh-secret-with-more-than-thirty-two-characters',
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 3600,
  COOKIE_SECURE: false,
  GEOAPIFY_API_KEY: '',
  PUSH_VAPID_SUBJECT: '',
  PUSH_VAPID_PUBLIC_KEY: '',
  PUSH_VAPID_PRIVATE_KEY: '',
  PUSH_APP_URL: '',
  PUSH_NOTIFICATION_ICON_URL: '',
  PUSH_NOTIFICATION_BADGE_URL: '',
  PUSH_DEFAULT_OPEN_URL: '',
  WHATSAPP_PHONE_NUMBER_ID: '',
  WHATSAPP_BUSINESS_ACCOUNT_ID: '',
  WHATSAPP_ACCESS_TOKEN: '',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: '',
  SMS_PROVIDER: '',
  SMS_API_KEY: '',
  PUBLIC_TRACKING_BASE_URL: '',
  TRACKING_TOKEN_PEPPER: 'tracking-pepper-with-more-than-32-characters',
  TRACKING_TOKEN_TTL_SECONDS: 604800,
  TRACKING_COMPLETED_GRACE_SECONDS: 3600,
  BACKGROUND_TRACKING_SESSION_TTL_SECONDS: 43200,
  RETENTION_LOCATION_DAYS: 90,
  RETENTION_AUDIT_DAYS: 365,
  RETENTION_OPERATIONAL_DAYS: 30,
  RETENTION_BATCH_SIZE: 5000,
  RETENTION_ENABLED: false,
  OUTBOX_MAX_ATTEMPTS: 5,
  OUTBOX_LEASE_SECONDS: 300,
  OUTBOX_RETRY_BASE_SECONDS: 30,
  OUTBOX_RETRY_MAX_SECONDS: 3600,
} satisfies AppEnv;

describe('app', () => {
  it('expõe liveness sem depender do banco', async () => {
    const app = await buildApp({ env });
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('expõe identidade não sensível do release', async () => {
    const app = await buildApp({ env });
    const response = await app.inject({ method: 'GET', url: '/health/version' });
    expect(response.json()).toEqual({ version: 'test', commit: 'test-commit', environment: 'test' });
    await app.close();
  });

  it('não distingue token público malformado e aplica cabeçalhos de privacidade', async () => {
    const app = await buildApp({ env });
    const response = await app.inject({ method: 'GET', url: '/public/tracking/invalido' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Acompanhamento indisponível.' },
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    await app.close();
  });

  it('expõe Redis desabilitado sem reprovar a prontidão quando o PostgreSQL responde', async () => {
    const database = {
      query: async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }),
      end: async () => undefined,
    };
    const app = await buildApp({ env, database: database as never });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready', dependencies: { postgres: 'ready', redis: 'disabled', realtime: 'local' },
    });
    await app.close();
  });

  it('reprova a prontidão quando Redis é obrigatório e está indisponível', async () => {
    const database = {
      query: async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }),
      end: async () => undefined,
    };
    const requiredEnv = { ...env, REDIS_REQUIRED: true };
    const redis = new RedisRuntime(false, true, 'rastreia-test:', null);
    const app = await buildApp({ env: requiredEnv, database: database as never, redisRuntime: redis });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'unavailable',
      dependencies: { postgres: 'ready', redis: 'unavailable', realtime: 'local' },
    });
    await app.close();
  });

  it('protege métricas e não inclui dados de requisição nos labels', async () => {
    const database = {
      query: async (sql: string) => sql.includes('outbox_events')
        ? { rows: [{ pending: 2, retrying: 1, dead_letters: 0, oldest_age: 15 }], rowCount: 1 }
        : { rows: [{ '?column?': 1 }], rowCount: 1 },
      end: async () => undefined,
    };
    const app = await buildApp({ env, database: database as never });
    const hidden = await app.inject({ method: 'GET', url: '/internal/metrics' });
    expect(hidden.statusCode).toBe(404);
    const response = await app.inject({
      method: 'GET', url: '/internal/metrics',
      headers: { authorization: `Bearer ${env.METRICS_BEARER_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('rastreia_http_requests_total');
    expect(response.body).toContain('rastreia_outbox_events');
    expect(response.body).not.toContain(env.METRICS_BEARER_TOKEN);
    await app.close();
  });
});
