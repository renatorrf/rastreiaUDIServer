SET LOCAL search_path TO rastreia, public;

CREATE TYPE platform_admin_status AS ENUM ('ACTIVE', 'BLOCKED', 'ARCHIVED');

CREATE TABLE platform_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  status platform_admin_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_refresh_sessions (
  id uuid PRIMARY KEY,
  platform_admin_id uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid REFERENCES platform_refresh_sessions(id) ON DELETE SET NULL,
  user_agent text,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_refresh_sessions_active_idx
  ON platform_refresh_sessions (platform_admin_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE platform_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_platform_admin_id uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  target_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  before_data jsonb,
  after_data jsonb,
  reason text,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_audit_logs_created_idx ON platform_audit_logs (created_at DESC);
CREATE INDEX platform_audit_logs_tenant_idx ON platform_audit_logs (target_tenant_id, created_at DESC);

CREATE TRIGGER platform_admins_touch_updated_at BEFORE UPDATE ON platform_admins
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER platform_refresh_sessions_touch_updated_at BEFORE UPDATE ON platform_refresh_sessions
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();

CREATE OR REPLACE FUNCTION rastreia.current_platform_admin_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.platform_admin_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION rastreia.resolve_platform_admin_email(requested_email text)
RETURNS TABLE (id uuid, name text, email citext, password_hash text, status platform_admin_status)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = rastreia, public, pg_temp
AS $$
  SELECT admin.id, admin.name, admin.email, admin.password_hash, admin.status
  FROM platform_admins admin
  WHERE admin.email = requested_email::citext
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION rastreia.tenant_is_active(requested_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = rastreia, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM tenants tenant WHERE tenant.id = requested_id AND tenant.status = 'ACTIVE')
$$;

REVOKE ALL ON FUNCTION rastreia.resolve_platform_admin_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rastreia.tenant_is_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.resolve_platform_admin_email(text) TO rastreia_runtime;
GRANT EXECUTE ON FUNCTION rastreia.tenant_is_active(uuid) TO rastreia_runtime;
GRANT EXECUTE ON FUNCTION rastreia.current_platform_admin_id() TO rastreia_runtime;

GRANT SELECT ON platform_admins TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE ON platform_refresh_sessions TO rastreia_runtime;
GRANT SELECT, INSERT ON platform_audit_logs TO rastreia_runtime;

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admins_self ON platform_admins
  USING (id = rastreia.current_platform_admin_id());

ALTER TABLE platform_refresh_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_refresh_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_refresh_sessions_self ON platform_refresh_sessions
  USING (platform_admin_id = rastreia.current_platform_admin_id())
  WITH CHECK (platform_admin_id = rastreia.current_platform_admin_id());

ALTER TABLE platform_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_audit_logs_authenticated ON platform_audit_logs
  USING (rastreia.current_platform_admin_id() IS NOT NULL)
  WITH CHECK (actor_platform_admin_id = rastreia.current_platform_admin_id());

CREATE POLICY tenants_platform_administration ON tenants
  USING (rastreia.current_platform_admin_id() IS NOT NULL)
  WITH CHECK (rastreia.current_platform_admin_id() IS NOT NULL);
