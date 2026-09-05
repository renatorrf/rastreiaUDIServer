SET LOCAL search_path TO rastreia, public;

CREATE TABLE customer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  first_name text NOT NULL CHECK (char_length(first_name) BETWEEN 2 AND 80),
  last_name text NOT NULL CHECK (char_length(last_name) BETWEEN 2 AND 120),
  whatsapp text NOT NULL CHECK (char_length(whatsapp) BETWEEN 10 AND 20),
  whatsapp_normalized text NOT NULL CHECK (char_length(whatsapp_normalized) BETWEEN 10 AND 11),
  address_line text NOT NULL,
  address_number text NOT NULL,
  complement text,
  neighborhood text NOT NULL,
  city text NOT NULL,
  state char(2) NOT NULL,
  postal_code text NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  address_confidence numeric(5,4) CHECK (address_confidence BETWEEN 0 AND 1),
  source_tracking_token_id uuid REFERENCES tracking_tokens(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  consent_at timestamptz NOT NULL DEFAULT now(),
  last_order_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, whatsapp_normalized)
);

CREATE TABLE customer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  customer_profile_id uuid NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (customer_profile_id, tenant_id)
    REFERENCES customer_profiles(id, tenant_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

ALTER TABLE deliveries ADD COLUMN customer_profile_id uuid;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_customer_profile_fk
  FOREIGN KEY (customer_profile_id, tenant_id)
  REFERENCES customer_profiles(id, tenant_id) ON DELETE RESTRICT;

CREATE INDEX customer_profiles_phone_idx ON customer_profiles (tenant_id, whatsapp_normalized);
CREATE INDEX customer_sessions_expiry_idx ON customer_sessions (expires_at) WHERE revoked_at IS NULL;
CREATE INDEX deliveries_customer_history_idx ON deliveries (tenant_id, customer_profile_id, created_at DESC)
  WHERE customer_profile_id IS NOT NULL;

CREATE TRIGGER customer_profiles_touch_updated_at BEFORE UPDATE ON customer_profiles
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();

ALTER TABLE customer_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_profiles_tenant ON customer_profiles
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE customer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_sessions_tenant ON customer_sessions
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());
CREATE POLICY customer_sessions_public_lookup ON customer_sessions
  FOR SELECT
  USING (token_hash = NULLIF(current_setting('app.customer_session_hash', true), ''));

GRANT SELECT, INSERT, UPDATE ON customer_profiles, customer_sessions TO rastreia_runtime;
