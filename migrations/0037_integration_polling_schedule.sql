SET LOCAL search_path TO rastreia,public;
ALTER TABLE integration_connections ADD COLUMN next_poll_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN last_worker_at timestamptz;
CREATE INDEX integrations_poll_due ON integration_connections(next_poll_at) WHERE enabled;
-- Keep received details even when destination validation prevents an import.
ALTER TABLE integration_events ADD COLUMN order_payload_encrypted text;
