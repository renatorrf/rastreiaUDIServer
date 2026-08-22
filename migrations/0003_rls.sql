SET LOCAL search_path TO rastreia, public;

CREATE OR REPLACE FUNCTION rastreia.resolve_tenant_slug(requested_slug text)
RETURNS TABLE (id uuid, slug citext, name text, status tenant_status, timezone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = rastreia, public, pg_temp
AS $$
  SELECT t.id, t.slug, t.name, t.status, t.timezone
  FROM tenants t
  WHERE t.slug = requested_slug::citext
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION rastreia.resolve_tenant_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.resolve_tenant_slug(text) TO PUBLIC;

-- `tenants` is intentionally resolved by a narrow SECURITY DEFINER function before
-- authentication. Runtime endpoints still address it by the authenticated id.
-- All operational tables below use FORCE RLS.

ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_users_isolation ON tenant_users
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_visibility ON users
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tenant_users membership
      WHERE membership.user_id = users.id
        AND membership.tenant_id = rastreia.current_tenant_id()
        AND membership.status = 'ACTIVE'
    )
  );
CREATE POLICY users_tenant_insert ON users
  FOR INSERT
  WITH CHECK (rastreia.current_tenant_id() IS NOT NULL);
CREATE POLICY users_tenant_update ON users
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM tenant_users membership
      WHERE membership.user_id = users.id
        AND membership.tenant_id = rastreia.current_tenant_id()
        AND membership.status = 'ACTIVE'
    )
  );

ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores FORCE ROW LEVEL SECURITY;
CREATE POLICY stores_isolation ON stores
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE user_store_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_store_access FORCE ROW LEVEL SECURITY;
CREATE POLICY user_store_access_isolation ON user_store_access
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE courier_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY courier_profiles_visibility ON courier_profiles
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tenant_users membership
      WHERE membership.user_id = courier_profiles.user_id
        AND membership.tenant_id = rastreia.current_tenant_id()
        AND membership.status = 'ACTIVE'
    )
  );
CREATE POLICY courier_profiles_insert ON courier_profiles
  FOR INSERT
  WITH CHECK (rastreia.current_tenant_id() IS NOT NULL);
CREATE POLICY courier_profiles_update ON courier_profiles
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM tenant_users membership
      WHERE membership.user_id = courier_profiles.user_id
        AND membership.tenant_id = rastreia.current_tenant_id()
        AND membership.status = 'ACTIVE'
    )
  );

ALTER TABLE courier_store_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_store_links FORCE ROW LEVEL SECURITY;
CREATE POLICY courier_store_links_isolation ON courier_store_links
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE refresh_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY refresh_sessions_isolation ON refresh_sessions
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_select ON audit_logs
  FOR SELECT USING (tenant_id = rastreia.current_tenant_id());
CREATE POLICY audit_logs_insert ON audit_logs
  FOR INSERT WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_events_isolation ON outbox_events
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());
