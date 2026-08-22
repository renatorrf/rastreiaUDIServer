SET LOCAL search_path TO rastreia, public;

CREATE TABLE platform_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_admin_id uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  operation text NOT NULL,
  request_hash char(64) NOT NULL,
  response_status integer,
  response_body jsonb,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform_admin_id, idempotency_key, operation)
);

CREATE INDEX platform_idempotency_expiry_idx ON platform_idempotency_keys (expires_at);
GRANT SELECT, INSERT, UPDATE ON platform_idempotency_keys TO rastreia_runtime;
ALTER TABLE platform_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_idempotency_self ON platform_idempotency_keys
  USING (platform_admin_id = rastreia.current_platform_admin_id())
  WITH CHECK (platform_admin_id = rastreia.current_platform_admin_id());
