SET LOCAL search_path TO rastreia, public;

-- Uma identidade pode participar de mais de uma empresa. A senha redefinida por
-- um gestor fica restrita ao vínculo do tenant e não altera o acesso aos demais.
ALTER TABLE tenant_users ADD COLUMN password_hash text;

CREATE TYPE password_reset_request_status AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

CREATE TABLE password_reset_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status password_reset_request_status NOT NULL DEFAULT 'PENDING',
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE UNIQUE INDEX password_reset_requests_pending_idx
  ON password_reset_requests (tenant_id, user_id)
  WHERE status = 'PENDING';
CREATE INDEX password_reset_requests_queue_idx
  ON password_reset_requests (tenant_id, status, requested_at DESC);

CREATE TRIGGER password_reset_requests_touch_updated_at BEFORE UPDATE ON password_reset_requests
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();

ALTER TABLE password_reset_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY password_reset_requests_isolation ON password_reset_requests
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON password_reset_requests TO rastreia_runtime;
GRANT UPDATE (password_hash) ON tenant_users TO rastreia_runtime;
