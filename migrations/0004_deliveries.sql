SET LOCAL search_path TO rastreia, public;

CREATE TYPE route_status AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE delivery_status AS ENUM (
  'DRAFT',
  'AWAITING_COURIER',
  'ASSIGNED',
  'AWAITING_PICKUP',
  'COLLECTED',
  'IN_ROUTE',
  'NEXT_STOP',
  'DELIVERED',
  'CANCELLED',
  'DELIVERY_FAILED',
  'RETURN_STARTED',
  'RETURNED'
);

CREATE TABLE routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id uuid NOT NULL,
  courier_profile_id uuid REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  status route_status NOT NULL DEFAULT 'DRAFT',
  planned_start_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (store_id, tenant_id) REFERENCES stores(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX routes_operation_idx ON routes (tenant_id, store_id, status, created_at DESC);

CREATE TABLE deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id uuid NOT NULL,
  route_id uuid,
  courier_profile_id uuid REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  external_reference text,
  recipient_name text NOT NULL CHECK (char_length(recipient_name) BETWEEN 2 AND 160),
  recipient_phone text NOT NULL CHECK (char_length(recipient_phone) BETWEEN 8 AND 30),
  recipient_whatsapp text,
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
  delivery_instructions text,
  status delivery_status NOT NULL DEFAULT 'DRAFT',
  promised_window_start timestamptz,
  promised_window_end timestamptz,
  collected_at timestamptz,
  out_for_delivery_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, external_reference),
  FOREIGN KEY (store_id, tenant_id) REFERENCES stores(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (route_id, tenant_id) REFERENCES routes(id, tenant_id) ON DELETE RESTRICT,
  CHECK (promised_window_end IS NULL OR promised_window_start IS NULL OR promised_window_end > promised_window_start)
);

CREATE INDEX deliveries_operation_idx ON deliveries (tenant_id, store_id, status, created_at DESC);
CREATE INDEX deliveries_courier_idx ON deliveries (tenant_id, courier_profile_id, status)
  WHERE courier_profile_id IS NOT NULL;
CREATE INDEX deliveries_coordinates_idx ON deliveries (tenant_id, latitude, longitude);

CREATE TABLE delivery_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  from_status delivery_status,
  to_status delivery_status NOT NULL,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  delivery_version integer NOT NULL CHECK (delivery_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, delivery_version),
  FOREIGN KEY (delivery_id, tenant_id) REFERENCES deliveries(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX delivery_status_history_timeline_idx
  ON delivery_status_history (tenant_id, delivery_id, created_at, delivery_version);

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  operation text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_hash char(64) NOT NULL,
  response_status integer,
  response_body jsonb,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key, operation)
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

CREATE TRIGGER routes_touch_updated_at BEFORE UPDATE ON routes
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER deliveries_touch_updated_at BEFORE UPDATE ON deliveries
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER idempotency_keys_touch_updated_at BEFORE UPDATE ON idempotency_keys
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();

ALTER TABLE routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE routes FORCE ROW LEVEL SECURITY;
CREATE POLICY routes_isolation ON routes
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY deliveries_isolation ON deliveries
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE delivery_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_status_history FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_status_history_isolation ON delivery_status_history
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_isolation ON idempotency_keys
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());
