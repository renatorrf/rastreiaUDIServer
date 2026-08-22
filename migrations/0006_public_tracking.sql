SET LOCAL search_path TO rastreia, public;

CREATE TABLE tracking_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  last_access_at timestamptz,
  last_access_ip inet,
  access_count integer NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (delivery_id, tenant_id) REFERENCES deliveries(id, tenant_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX tracking_tokens_active_delivery_idx
  ON tracking_tokens (tenant_id, delivery_id)
  WHERE revoked_at IS NULL;
CREATE INDEX tracking_tokens_expiry_idx ON tracking_tokens (expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE tracking_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY tracking_tokens_tenant ON tracking_tokens
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

-- A consulta pública conhece somente o HMAC calculado pelo backend. Depois de
-- localizar o vínculo, a transação configura o tenant antes de ler a entrega.
CREATE POLICY tracking_tokens_public_lookup ON tracking_tokens
  FOR SELECT
  USING (
    token_hash = NULLIF(current_setting('app.tracking_hash', true), '')
  );

GRANT SELECT, INSERT, UPDATE ON tracking_tokens TO rastreia_runtime;
