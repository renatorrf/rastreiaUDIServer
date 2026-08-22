import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool } from '../database/pool.js';
import { createRedisRuntime } from '../infrastructure/redis/redis-runtime.js';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

loadLocalEnv();
const env = getEnv();
const database = createPool(env);
const redis = await createRedisRuntime(env);

try {
  const schema = await database.query<{
    migrated: boolean;
    dead_letter_table: boolean;
    lease_columns: boolean;
    rls_forced: boolean;
    retention_migrated: boolean;
    retention_worker_only: boolean;
  }>(
    `SELECT
       EXISTS (SELECT 1 FROM rastreia.schema_migrations
               WHERE name = '0021_outbox_dead_letters.sql') AS migrated,
       to_regclass('rastreia.outbox_dead_letters') IS NOT NULL AS dead_letter_table,
       (SELECT count(*) = 3 FROM information_schema.columns
        WHERE table_schema = 'rastreia' AND table_name = 'outbox_events'
          AND column_name IN ('locked_at', 'locked_by', 'dead_lettered_at')) AS lease_columns,
       EXISTS (SELECT 1 FROM pg_class candidate
               JOIN pg_namespace namespace ON namespace.oid = candidate.relnamespace
               WHERE namespace.nspname = 'rastreia' AND candidate.relname = 'outbox_dead_letters'
                 AND candidate.relrowsecurity AND candidate.relforcerowsecurity) AS rls_forced,
       EXISTS (SELECT 1 FROM rastreia.schema_migrations
               WHERE name = '0022_retention_maintenance.sql') AS retention_migrated,
       NOT has_table_privilege('rastreia_runtime', 'rastreia.maintenance_runs', 'SELECT')
         AS retention_worker_only`,
  );
  const checks = schema.rows[0]!;
  assertCondition(checks.migrated, 'Migration 0021 não aplicada.');
  assertCondition(checks.dead_letter_table, 'Tabela de dead-letter ausente.');
  assertCondition(checks.lease_columns, 'Colunas de lease do outbox ausentes.');
  assertCondition(checks.rls_forced, 'RLS forçada da dead-letter ausente.');
  assertCondition(checks.retention_migrated, 'Migration 0022 não aplicada.');
  assertCondition(checks.retention_worker_only, 'Papel da API obteve acesso indevido à manutenção global.');

  let redisIntegration = 'skipped:not-configured';
  if (redis.status !== 'disabled') {
    assertCondition(redis.status === 'ready', 'Redis configurado, mas indisponível.');
    assertCondition(await redis.ping(), 'Redis não respondeu ao ping.');
    const firstLease = await redis.acquireLease('smoke:phase5-scale', 10_000);
    assertCondition(firstLease !== null, 'Redis não concedeu o primeiro lease.');
    const competingLease = await redis.acquireLease('smoke:phase5-scale', 10_000);
    assertCondition(competingLease === null, 'Redis concedeu leases concorrentes.');
    await firstLease?.();
    redisIntegration = 'passed';
  }

  process.stdout.write(`${JSON.stringify({ ok: true, ...checks, redisIntegration }, null, 2)}\n`);
} finally {
  await redis.close();
  await database.end();
}
