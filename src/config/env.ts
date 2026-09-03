import { z } from 'zod';

const optionalSecret = z.string().trim().optional().default('');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  MASTER_ACCESS_TOKEN: z.string().trim().max(256).optional().default('').refine(
    value => value === '' || value.length >= 32, 'Use um token master de pelo menos 32 caracteres.',
  ),
  APP_ORIGINS: z.string().default('http://localhost:8100'),
  EMAIL_ACTION_BASE_URL: z.string().url().default('http://localhost:8100'),
  SMTP_HOST: optionalSecret,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.string().default('false').transform((value) => value === 'true'),
  SMTP_USER: optionalSecret,
  SMTP_PASSWORD: optionalSecret,
  SMTP_FROM: optionalSecret,
  BILLING_ENABLED: z.string().default('false').transform((value) => value === 'true'),
  PUBLIC_COURIER_REGISTRATION_ENABLED: z.string().default('false').transform((value) => value === 'true'),
  TERMS_URL: optionalSecret,
  PRIVACY_URL: optionalSecret,
  LEGAL_DOCUMENTS_VERSION: z.string().trim().min(1).default('2026-09'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DEPLOYMENT_ENVIRONMENT: z.string().trim().min(1).default('local'),
  RELEASE_VERSION: z.string().trim().min(1).default('dev'),
  RELEASE_COMMIT: z.string().trim().min(1).default('unknown'),
  METRICS_BEARER_TOKEN: optionalSecret,
  OTEL_SERVICE_NAME: z.string().trim().min(1).default('rastreia-backend'),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: optionalSecret,
  OTEL_TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.1),
  REDIS_URL: optionalSecret,
  REDIS_REQUIRED: z.string().default('false').transform((value) => value === 'true'),
  REDIS_KEY_PREFIX: z.string().trim().min(1).default('rastreia'),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(2_000),
  REDIS_LOCATION_TTL_SECONDS: z.coerce.number().int().min(120).max(86_400).default(900),
  REDIS_PRESENCE_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(120),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_SECRET_PREVIOUS: optionalSecret,
  JWT_REFRESH_SECRET_PREVIOUS: optionalSecret,
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  COOKIE_SECURE: z.string().default('true').transform((value) => value === 'true'),
  GEOAPIFY_API_KEY: optionalSecret,
  IFOOD_ENABLED: z.string().default('false').transform(value => value === 'true'),
  IFOOD_MODE: z.enum(['mock', 'sandbox', 'production']).default('mock'),
  IFOOD_CLIENT_ID: optionalSecret,
  IFOOD_CLIENT_SECRET: optionalSecret,
  IFOOD_BASE_URL: z.url().default('https://merchant-api.ifood.com.br'),
  IFOOD_EVENTS_MODE: z.enum(['polling', 'webhook']).default('polling'),
  IFOOD_POLLING_INTERVAL_MS: z.coerce.number().int().min(30_000).max(300_000).default(30_000),
  IFOOD_WEBHOOK_ENABLED: z.string().default('false').transform(value => value === 'true'),
  IFOOD_WEBHOOK_SECRET: optionalSecret,
  IFOOD_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(15_000),
  PUSH_VAPID_SUBJECT: optionalSecret,
  PUSH_VAPID_PUBLIC_KEY: optionalSecret,
  PUSH_VAPID_PRIVATE_KEY: optionalSecret,
  PUSH_APP_URL: optionalSecret,
  PUSH_NOTIFICATION_ICON_URL: optionalSecret,
  PUSH_NOTIFICATION_BADGE_URL: optionalSecret,
  PUSH_DEFAULT_OPEN_URL: optionalSecret,
  MESSAGE_PAYLOAD_SECRET: optionalSecret,
  NOTIFICATION_WORKER_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  OUTBOX_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  OUTBOX_RETRY_BASE_SECONDS: z.coerce.number().int().min(1).max(3_600).default(30),
  OUTBOX_RETRY_MAX_SECONDS: z.coerce.number().int().min(30).max(86_400).default(3_600),
  COMMUNICATIONS_MOCK: z.string().default('false').transform((value) => value === 'true'),
  WHATSAPP_PHONE_NUMBER_ID: optionalSecret,
  WHATSAPP_BUSINESS_ACCOUNT_ID: optionalSecret,
  WHATSAPP_ACCESS_TOKEN: optionalSecret,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: optionalSecret,
  WHATSAPP_APP_SECRET: optionalSecret,
  WHATSAPP_GRAPH_VERSION: z.string().trim().regex(/^v\d+\.\d+$/).default('v23.0'),
  WHATSAPP_TRACKING_TEMPLATE: z.string().trim().default('rastreia_acompanhamento'),
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().trim().default('pt_BR'),
  SMS_PROVIDER: optionalSecret,
  SMS_API_KEY: optionalSecret,
  SMS_API_URL: optionalSecret,
  OBJECT_STORAGE_PATH: z.string().trim().default('.data/objects'),
  OBJECT_STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  S3_ENDPOINT: optionalSecret,
  S3_REGION: z.string().trim().default('us-east-1'),
  S3_BUCKET: optionalSecret,
  S3_ACCESS_KEY_ID: optionalSecret,
  S3_SECRET_ACCESS_KEY: optionalSecret,
  S3_FORCE_PATH_STYLE: z.string().default('false').transform((value) => value === 'true'),
  PROOF_MAX_FILE_SIZE_BYTES: z.coerce.number().int().min(1024).max(5_242_880).default(5_242_880),
  PUBLIC_TRACKING_BASE_URL: optionalSecret,
  TRACKING_TOKEN_PEPPER: z.string().min(32),
  TRACKING_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  TRACKING_COMPLETED_GRACE_SECONDS: z.coerce.number().int().positive().default(3_600),
  BACKGROUND_TRACKING_SESSION_TTL_SECONDS: z.coerce.number().int().min(900).max(86_400).default(43_200),
  RETENTION_LOCATION_DAYS: z.coerce.number().int().min(7).max(730).default(90),
  RETENTION_AUDIT_DAYS: z.coerce.number().int().min(90).max(3_650).default(365),
  RETENTION_OPERATIONAL_DAYS: z.coerce.number().int().min(7).max(730).default(30),
  RETENTION_BATCH_SIZE: z.coerce.number().int().min(100).max(100_000).default(5_000),
  RETENTION_ENABLED: z.string().default('false').transform((value) => value === 'true'),
  BOOTSTRAP_TENANT_SLUG: z.string().min(2).optional(),
  BOOTSTRAP_TENANT_NAME: z.string().min(2).optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().min(2).optional(),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
  BOOTSTRAP_PLATFORM_ADMIN_NAME: z.string().min(2).optional(),
  BOOTSTRAP_PLATFORM_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: z.string().min(12).optional(),
}).superRefine((env, context) => {
  if (env.IFOOD_ENABLED && env.IFOOD_MODE !== 'mock' && (!env.IFOOD_CLIENT_ID || !env.IFOOD_CLIENT_SECRET)) {
    context.addIssue({ code: 'custom', path: ['IFOOD_CLIENT_ID'], message: 'Configure as credenciais iFood no backend.' });
  }
  if (env.IFOOD_MODE !== 'mock' && env.IFOOD_BASE_URL !== 'https://merchant-api.ifood.com.br') {
    context.addIssue({ code: 'custom', path: ['IFOOD_BASE_URL'], message: 'Use o host oficial da Merchant API.' });
  }
  if (env.NODE_ENV === 'production' && env.IFOOD_ENABLED && env.IFOOD_MODE === 'mock') {
    context.addIssue({ code: 'custom', path: ['IFOOD_MODE'], message: 'Simulação iFood não pode ser ativada em produção.' });
  }
  if (env.NODE_ENV !== 'production') return;
  const issue = (path: string, message: string) => context.addIssue({
    code: 'custom', path: [path], message,
  });
  if (env.DEPLOYMENT_ENVIRONMENT === 'local') {
    issue('DEPLOYMENT_ENVIRONMENT', 'Defina um ambiente de implantação explícito em produção.');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(env.RELEASE_VERSION)) {
    issue('RELEASE_VERSION', 'Informe a versão semântica implantada.');
  }
  if (!/^[a-f0-9]{7,64}$/i.test(env.RELEASE_COMMIT)) {
    issue('RELEASE_COMMIT', 'Informe o hash do commit implantado.');
  }
  if (!env.COOKIE_SECURE) issue('COOKIE_SECURE', 'Cookies seguros são obrigatórios em produção.');
  if ((env.SMTP_HOST || env.PUBLIC_COURIER_REGISTRATION_ENABLED) && !env.EMAIL_ACTION_BASE_URL.startsWith('https://')) {
    issue('EMAIL_ACTION_BASE_URL', 'Links de convite e recuperação devem usar a URL HTTPS do frontend.');
  }
  if (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') {
    issue('LOG_LEVEL', 'Debug/trace não devem permanecer habilitados em produção.');
  }
  const origins = env.APP_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean);
  if (origins.length === 0 || origins.some((origin) => !origin.startsWith('https://'))) {
    issue('APP_ORIGINS', 'Todas as origens de produção devem usar HTTPS.');
  }
  if (!env.PUBLIC_TRACKING_BASE_URL.startsWith('https://')) {
    issue('PUBLIC_TRACKING_BASE_URL', 'O acompanhamento público deve usar HTTPS.');
  }
  if (!env.REDIS_REQUIRED || !env.REDIS_URL.startsWith('rediss://')) {
    issue('REDIS_URL', 'Redis obrigatório com TLS (`rediss://`) é exigido em produção.');
  }
  if (env.METRICS_BEARER_TOKEN.length < 32) {
    issue('METRICS_BEARER_TOKEN', 'Use uma credencial exclusiva de ao menos 32 caracteres.');
  }
  if (env.OBJECT_STORAGE_PROVIDER !== 's3' || !env.S3_BUCKET
      || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    issue('OBJECT_STORAGE_PROVIDER', 'Storage S3 e credenciais são obrigatórios em produção.');
  }
  if (env.MESSAGE_PAYLOAD_SECRET.length < 32
      || env.MESSAGE_PAYLOAD_SECRET === env.TRACKING_TOKEN_PEPPER) {
    issue('MESSAGE_PAYLOAD_SECRET', 'Use um segredo exclusivo de ao menos 32 caracteres.');
  }
  if (new Set([env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET, env.TRACKING_TOKEN_PEPPER,
    env.MESSAGE_PAYLOAD_SECRET]).size !== 4) {
    issue('JWT_ACCESS_SECRET', 'Segredos JWT, tracking e payload devem ser distintos.');
  }
  if (env.JWT_ACCESS_SECRET_PREVIOUS
      && (env.JWT_ACCESS_SECRET_PREVIOUS.length < 32
        || env.JWT_ACCESS_SECRET_PREVIOUS === env.JWT_ACCESS_SECRET)) {
    issue('JWT_ACCESS_SECRET_PREVIOUS', 'O segredo anterior deve ser válido e diferente do atual.');
  }
  if (env.JWT_REFRESH_SECRET_PREVIOUS
      && (env.JWT_REFRESH_SECRET_PREVIOUS.length < 32
        || env.JWT_REFRESH_SECRET_PREVIOUS === env.JWT_REFRESH_SECRET)) {
    issue('JWT_REFRESH_SECRET_PREVIOUS', 'O segredo anterior deve ser válido e diferente do atual.');
  }
  if (env.COMMUNICATIONS_MOCK) {
    issue('COMMUNICATIONS_MOCK', 'O mock de comunicações não pode ser usado em produção.');
  }
  if (!env.RETENTION_ENABLED) {
    issue('RETENTION_ENABLED', 'A política de retenção deve ser explicitamente habilitada em produção.');
  }
  if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT.startsWith('https://')) {
    issue('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'O exportador OTLP de produção deve usar HTTPS.');
  }
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | undefined;

export function parseAppEnv(source: NodeJS.ProcessEnv): AppEnv {
  return envSchema.parse(source);
}

export function getEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  cached ??= parseAppEnv(source);
  return cached;
}

export function resetEnvForTests(): void {
  cached = undefined;
}
