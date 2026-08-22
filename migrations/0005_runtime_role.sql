SET LOCAL search_path TO rastreia, public;

-- The configured connection may own the schema or be a superuser so migrations
-- can run. API transactions assume this non-login role to make FORCE RLS effective.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rastreia_runtime') THEN
    CREATE ROLE rastreia_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT rastreia_runtime TO %I', current_user);
END
$$;

GRANT USAGE ON SCHEMA rastreia TO rastreia_runtime;

GRANT SELECT, INSERT, UPDATE ON
  tenants,
  users,
  tenant_users,
  stores,
  user_store_access,
  courier_profiles,
  courier_store_links,
  refresh_sessions,
  audit_logs,
  outbox_events,
  routes,
  deliveries,
  delivery_status_history,
  idempotency_keys
TO rastreia_runtime;

GRANT EXECUTE ON FUNCTION rastreia.current_tenant_id() TO rastreia_runtime;
GRANT EXECUTE ON FUNCTION rastreia.current_user_id() TO rastreia_runtime;
GRANT EXECUTE ON FUNCTION rastreia.resolve_tenant_slug(text) TO rastreia_runtime;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_isolation ON tenants
  USING (id = rastreia.current_tenant_id())
  WITH CHECK (id = rastreia.current_tenant_id());
