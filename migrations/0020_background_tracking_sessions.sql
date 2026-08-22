SET LOCAL search_path TO rastreia, public;

CREATE TABLE background_tracking_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  platform text NOT NULL CHECK (platform IN ('android', 'ios')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (delivery_id, tenant_id) REFERENCES deliveries(id, tenant_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX background_tracking_sessions_active_courier_idx
  ON background_tracking_sessions (tenant_id, courier_profile_id)
  WHERE revoked_at IS NULL;
CREATE INDEX background_tracking_sessions_expiry_idx
  ON background_tracking_sessions (expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE background_tracking_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_tracking_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY background_tracking_sessions_tenant ON background_tracking_sessions
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

-- O endpoint nativo ainda não conhece o tenant. Ele configura somente o HMAC
-- do segredo recebido e a RLS permite localizar, no máximo, a linha exata.
CREATE POLICY background_tracking_sessions_token_lookup ON background_tracking_sessions
  FOR SELECT
  USING (
    token_hash = NULLIF(current_setting('app.background_tracking_hash', true), '')
  );

GRANT SELECT, INSERT, UPDATE ON background_tracking_sessions TO rastreia_runtime;
