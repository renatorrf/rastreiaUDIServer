SET LOCAL search_path TO rastreia, public;

ALTER TABLE outbox_events
  ADD COLUMN locked_at timestamptz,
  ADD COLUMN locked_by text,
  ADD COLUMN dead_lettered_at timestamptz;

CREATE TABLE outbox_dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_event_id uuid NOT NULL UNIQUE REFERENCES outbox_events(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  last_error text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  replayed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  replay_event_id uuid REFERENCES outbox_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_dead_letters_tenant_failed_idx
  ON outbox_dead_letters (tenant_id, failed_at DESC);
CREATE INDEX outbox_events_queue_metrics_idx
  ON outbox_events (tenant_id, occurred_at)
  WHERE processed_at IS NULL;

CREATE TRIGGER outbox_dead_letters_touch_updated_at BEFORE UPDATE ON outbox_dead_letters
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();

ALTER TABLE outbox_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_dead_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_dead_letters_isolation ON outbox_dead_letters
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON outbox_dead_letters TO rastreia_runtime;
