import type { Database } from '../../database/pool.js';
import { withTenantTransaction } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, notFound } from '../../shared/errors.js';
import type { AuthContext } from '../auth/auth.types.js';

export async function getQueueHealth(database: Database, auth: AuthContext) {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query<{
      pending: number;
      retrying: number;
      dead_letters: number;
      oldest_pending_at: Date | null;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM outbox_events
          WHERE tenant_id = $1 AND processed_at IS NULL) AS pending,
         (SELECT count(*)::integer FROM outbox_events
          WHERE tenant_id = $1 AND processed_at IS NULL AND attempts > 0) AS retrying,
         (SELECT count(*)::integer FROM outbox_dead_letters
          WHERE tenant_id = $1 AND replayed_at IS NULL) AS dead_letters,
         (SELECT min(occurred_at) FROM outbox_events
          WHERE tenant_id = $1 AND processed_at IS NULL) AS oldest_pending_at`,
      [auth.tenantId],
    );
    const row = result.rows[0]!;
    return {
      pending: row.pending,
      retrying: row.retrying,
      deadLetters: row.dead_letters,
      oldestPendingAt: row.oldest_pending_at,
    };
  });
}

export async function listDeadLetters(database: Database, auth: AuthContext, limit: number) {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query(
      `SELECT id, original_event_id AS "originalEventId", aggregate_type AS "aggregateType",
              aggregate_id AS "aggregateId", event_type AS "eventType", attempts,
              last_error AS "lastError", failed_at AS "failedAt",
              replayed_at AS "replayedAt", replay_event_id AS "replayEventId"
       FROM outbox_dead_letters
       WHERE tenant_id = $1
       ORDER BY failed_at DESC
       LIMIT $2`,
      [auth.tenantId, limit],
    );
    return { data: result.rows };
  });
}

export async function replayDeadLetter(
  database: Database,
  auth: AuthContext,
  deadLetterId: string,
  ip?: string,
) {
  return withTenantTransaction(database, auth, async (client) => {
    const found = await client.query<{
      id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      replayed_at: Date | null;
    }>(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, replayed_at
       FROM outbox_dead_letters
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [deadLetterId, auth.tenantId],
    );
    const deadLetter = found.rows[0];
    if (!deadLetter) throw notFound('Evento da fila de falhas não encontrado.');
    if (deadLetter.replayed_at) throw conflict('Este evento já foi reenfileirado.');

    const replay = await client.query<{ id: string }>(
      `INSERT INTO outbox_events
         (tenant_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [auth.tenantId, deadLetter.aggregate_type, deadLetter.aggregate_id,
        deadLetter.event_type, deadLetter.payload],
    );
    const replayEventId = replay.rows[0]!.id;
    await client.query(
      `UPDATE outbox_dead_letters
       SET replayed_at = now(), replayed_by = $2, replay_event_id = $3
       WHERE id = $1`,
      [deadLetter.id, auth.userId, replayEventId],
    );
    await writeAudit(client, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'outbox.dead_letter.replayed',
      entityType: 'outbox_dead_letter',
      entityId: deadLetter.id,
      afterData: { replayEventId, eventType: deadLetter.event_type },
      ...(ip === undefined ? {} : { ip }),
    });
    return { replayEventId };
  });
}
