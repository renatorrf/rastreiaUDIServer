SET LOCAL search_path TO rastreia, public;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  legal_name text,
  status tenant_status NOT NULL DEFAULT 'ACTIVE',
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  contact_phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  status user_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role tenant_role NOT NULL,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  status user_status NOT NULL DEFAULT 'ACTIVE',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (id, tenant_id)
);

CREATE INDEX tenant_users_tenant_role_idx ON tenant_users (tenant_id, role, status);
CREATE INDEX tenant_users_user_idx ON tenant_users (user_id, status);

CREATE TABLE stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  external_reference text,
  address_line text NOT NULL,
  address_number text,
  complement text,
  neighborhood text,
  city text NOT NULL,
  state char(2) NOT NULL,
  postal_code text,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  address_confidence numeric(5,4) CHECK (address_confidence BETWEEN 0 AND 1),
  contact_phone text,
  status store_status NOT NULL DEFAULT 'ACTIVE',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_reference),
  UNIQUE (id, tenant_id)
);

CREATE INDEX stores_tenant_status_idx ON stores (tenant_id, status);
CREATE INDEX stores_coordinates_idx ON stores (tenant_id, latitude, longitude);

CREATE TABLE user_store_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tenant_user_id uuid NOT NULL,
  store_id uuid NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_user_id, store_id),
  FOREIGN KEY (tenant_user_id, tenant_id) REFERENCES tenant_users(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (store_id, tenant_id) REFERENCES stores(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX user_store_access_tenant_store_idx ON user_store_access (tenant_id, store_id);

CREATE TABLE courier_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  phone text NOT NULL,
  vehicle_type vehicle_type NOT NULL,
  status courier_status NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE courier_store_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id uuid NOT NULL,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  status courier_link_status NOT NULL DEFAULT 'PENDING',
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, store_id, courier_profile_id),
  FOREIGN KEY (store_id, tenant_id) REFERENCES stores(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX courier_store_links_lookup_idx
  ON courier_store_links (tenant_id, store_id, status);

CREATE TABLE refresh_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid REFERENCES refresh_sessions(id) ON DELETE SET NULL,
  user_agent text,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_sessions_active_idx
  ON refresh_sessions (tenant_id, user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_tenant_created_idx ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (tenant_id, entity_type, entity_id);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_events_pending_idx
  ON outbox_events (available_at, occurred_at)
  WHERE processed_at IS NULL;

CREATE TRIGGER tenants_touch_updated_at BEFORE UPDATE ON tenants
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER tenant_users_touch_updated_at BEFORE UPDATE ON tenant_users
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER stores_touch_updated_at BEFORE UPDATE ON stores
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER user_store_access_touch_updated_at BEFORE UPDATE ON user_store_access
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER courier_profiles_touch_updated_at BEFORE UPDATE ON courier_profiles
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER courier_store_links_touch_updated_at BEFORE UPDATE ON courier_store_links
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER refresh_sessions_touch_updated_at BEFORE UPDATE ON refresh_sessions
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER outbox_events_touch_updated_at BEFORE UPDATE ON outbox_events
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
