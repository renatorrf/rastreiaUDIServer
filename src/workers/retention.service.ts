import type { AppEnv } from '../config/env.js';
import { withTransaction, type Database } from '../database/pool.js';

export interface RetentionResult {
  ran: boolean;
  locationPoints: number;
  locationReceipts: number;
  auditLogs: number;
  platformAuditLogs: number;
  idempotencyKeys: number;
  platformIdempotencyKeys: number;
  notificationAttempts: number;
  webhookReceipts: number;
  backgroundSessions: number;
  deadLetters: number;
  outboxEvents: number;
}

const emptyResult = (): RetentionResult => ({
  ran: false,
  locationPoints: 0,
  locationReceipts: 0,
  auditLogs: 0,
  platformAuditLogs: 0,
  idempotencyKeys: 0,
  platformIdempotencyKeys: 0,
  notificationAttempts: 0,
  webhookReceipts: 0,
  backgroundSessions: 0,
  deadLetters: 0,
  outboxEvents: 0,
});

async function deleteBatch(
  client: { query: (sql: string, parameters: unknown[]) => Promise<{ rowCount: number | null }> },
  table: string,
  timestampColumn: string,
  days: number,
  limit: number,
  extraPredicate = '',
): Promise<number> {
  // Identificadores vêm somente das constantes abaixo, nunca de configuração ou entrada externa.
  const result = await client.query(
    `DELETE FROM rastreia.${table}
     WHERE id IN (
       SELECT id FROM rastreia.${table}
       WHERE ${timestampColumn} < now() - ($1::text || ' days')::interval
         ${extraPredicate}
       ORDER BY ${timestampColumn}
       LIMIT $2
     )`,
    [days, limit],
  );
  return result.rowCount ?? 0;
}

export async function enforceRetentionPolicies(database: Database, env: AppEnv): Promise<RetentionResult> {
  if (!env.RETENTION_ENABLED) return emptyResult();
  return withTransaction(database, async (client) => {
    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('rastreia.retention.daily')) AS acquired`,
    );
    if (!lock.rows[0]?.acquired) return emptyResult();

    const due = await client.query<{ due: boolean }>(
      `INSERT INTO rastreia.maintenance_runs (task_name, last_started_at)
       VALUES ('retention.daily', now())
       ON CONFLICT (task_name) DO UPDATE
       SET last_started_at = now()
       WHERE maintenance_runs.last_started_at < now() - interval '23 hours'
       RETURNING true AS due`,
    );
    if (!due.rows[0]?.due) return emptyResult();

    const limit = env.RETENTION_BATCH_SIZE;
    const result: RetentionResult = {
      ran: true,
      locationPoints: await deleteBatch(client, 'location_points', 'received_at', env.RETENTION_LOCATION_DAYS, limit),
      locationReceipts: await deleteBatch(client, 'location_event_receipts', 'received_at', env.RETENTION_LOCATION_DAYS, limit),
      auditLogs: await deleteBatch(client, 'audit_logs', 'created_at', env.RETENTION_AUDIT_DAYS, limit),
      platformAuditLogs: await deleteBatch(client, 'platform_audit_logs', 'created_at', env.RETENTION_AUDIT_DAYS, limit),
      idempotencyKeys: await deleteBatch(client, 'idempotency_keys', 'expires_at', 0, limit),
      platformIdempotencyKeys: await deleteBatch(client, 'platform_idempotency_keys', 'expires_at', 0, limit),
      notificationAttempts: await deleteBatch(client, 'notification_attempts', 'created_at', env.RETENTION_OPERATIONAL_DAYS, limit),
      webhookReceipts: await deleteBatch(client, 'message_webhook_receipts', 'created_at', env.RETENTION_OPERATIONAL_DAYS, limit),
      backgroundSessions: await deleteBatch(client, 'background_tracking_sessions', 'expires_at', env.RETENTION_OPERATIONAL_DAYS, limit),
      deadLetters: await deleteBatch(
        client, 'outbox_dead_letters', 'replayed_at', env.RETENTION_OPERATIONAL_DAYS, limit,
        'AND replayed_at IS NOT NULL',
      ),
      outboxEvents: await deleteBatch(
        client, 'outbox_events', 'processed_at', env.RETENTION_OPERATIONAL_DAYS, limit,
        `AND NOT EXISTS (SELECT 1 FROM rastreia.outbox_dead_letters dead
                         WHERE dead.original_event_id = outbox_events.id
                            OR dead.replay_event_id = outbox_events.id)`,
      ),
    };
    await client.query(
      `UPDATE rastreia.maintenance_runs
       SET last_completed_at = now(), last_result = $2::jsonb
       WHERE task_name = $1`,
      ['retention.daily', JSON.stringify(result)],
    );
    return result;
  });
}
