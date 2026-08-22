SET LOCAL search_path TO rastreia, public;

CREATE TABLE maintenance_runs (
  task_name text PRIMARY KEY,
  last_started_at timestamptz NOT NULL,
  last_completed_at timestamptz,
  last_result jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER maintenance_runs_touch_updated_at BEFORE UPDATE ON maintenance_runs
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();

CREATE INDEX audit_logs_retention_idx ON audit_logs (created_at);
CREATE INDEX notification_attempts_retention_idx ON notification_attempts (created_at);
CREATE INDEX message_webhook_receipts_retention_idx ON message_webhook_receipts (created_at);
CREATE INDEX outbox_events_processed_retention_idx ON outbox_events (processed_at)
  WHERE processed_at IS NOT NULL;
CREATE INDEX outbox_dead_letters_replayed_retention_idx ON outbox_dead_letters (replayed_at)
  WHERE replayed_at IS NOT NULL;
CREATE INDEX background_tracking_sessions_retention_idx ON background_tracking_sessions (expires_at);

-- Esta tabela é deliberadamente global e acessível apenas ao dono das migrations/worker.
-- A API usa `rastreia_runtime`, que não recebe privilégios sobre ela.
