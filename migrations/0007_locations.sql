SET LOCAL search_path TO rastreia, public;

CREATE TABLE location_event_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  client_event_id uuid NOT NULL,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, courier_profile_id, client_event_id),
  FOREIGN KEY (delivery_id, tenant_id) REFERENCES deliveries(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX location_event_receipts_retention_idx
  ON location_event_receipts (received_at);

CREATE TABLE courier_last_locations (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  store_id uuid NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy double precision NOT NULL CHECK (accuracy > 0 AND accuracy <= 1000),
  speed double precision CHECK (speed >= 0 AND speed <= 100),
  heading double precision CHECK (heading >= 0 AND heading <= 360),
  altitude double precision,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, courier_profile_id),
  FOREIGN KEY (delivery_id, tenant_id) REFERENCES deliveries(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (store_id, tenant_id) REFERENCES stores(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX courier_last_locations_delivery_idx
  ON courier_last_locations (tenant_id, delivery_id, captured_at DESC);
CREATE INDEX courier_last_locations_freshness_idx
  ON courier_last_locations (tenant_id, captured_at DESC);

CREATE TABLE location_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  store_id uuid NOT NULL,
  client_event_id uuid NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy double precision NOT NULL CHECK (accuracy > 0 AND accuracy <= 1000),
  speed double precision CHECK (speed >= 0 AND speed <= 100),
  heading double precision CHECK (heading >= 0 AND heading <= 360),
  altitude double precision,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, courier_profile_id, client_event_id),
  FOREIGN KEY (delivery_id, tenant_id) REFERENCES deliveries(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (store_id, tenant_id) REFERENCES stores(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX location_points_timeline_idx
  ON location_points (tenant_id, delivery_id, captured_at DESC);
CREATE INDEX location_points_retention_idx ON location_points (received_at);

ALTER TABLE location_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_event_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY location_event_receipts_isolation ON location_event_receipts
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE courier_last_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_last_locations FORCE ROW LEVEL SECURITY;
CREATE POLICY courier_last_locations_isolation ON courier_last_locations
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE location_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_points FORCE ROW LEVEL SECURITY;
CREATE POLICY location_points_isolation ON location_points
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

GRANT SELECT, INSERT ON location_event_receipts TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE ON courier_last_locations TO rastreia_runtime;
GRANT SELECT, INSERT ON location_points TO rastreia_runtime;
