SET search_path TO rastreia, public;

CREATE TYPE route_stop_type AS ENUM ('PICKUP', 'DELIVERY');
CREATE TYPE route_stop_status AS ENUM ('PENDING', 'COMPLETED', 'SKIPPED');

ALTER TABLE routes
  ADD COLUMN label text NOT NULL DEFAULT 'Lote de entregas' CHECK (char_length(label) BETWEEN 3 AND 120),
  ADD COLUMN notes text CHECK (notes IS NULL OR char_length(notes) <= 1000);

CREATE TABLE route_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  route_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  stop_type route_stop_type NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  status route_stop_status NOT NULL DEFAULT 'PENDING',
  completed_at timestamptz,
  completed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, route_id, sequence),
  UNIQUE (tenant_id, route_id, delivery_id, stop_type),
  FOREIGN KEY (route_id, tenant_id) REFERENCES routes(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (delivery_id, tenant_id) REFERENCES deliveries(id, tenant_id) ON DELETE RESTRICT,
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);

CREATE INDEX route_stops_progress_idx ON route_stops (tenant_id, route_id, status, sequence);

CREATE TABLE route_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  route_id uuid NOT NULL,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 3 AND 80),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (route_id, tenant_id) REFERENCES routes(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX route_events_timeline_idx ON route_events (tenant_id, route_id, created_at);

CREATE TRIGGER route_stops_touch_updated_at BEFORE UPDATE ON route_stops
  FOR EACH ROW EXECUTE PROCEDURE touch_updated_at();

ALTER TABLE route_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_stops FORCE ROW LEVEL SECURITY;
ALTER TABLE route_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_events FORCE ROW LEVEL SECURITY;

CREATE POLICY route_stops_tenant_policy ON route_stops
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY route_events_tenant_policy ON route_events
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON route_stops TO rastreia_runtime;
GRANT SELECT, INSERT ON route_events TO rastreia_runtime;
