SET LOCAL search_path TO rastreia, public;

CREATE TYPE shift_slot_status AS ENUM ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE shift_position_status AS ENUM ('RESERVED', 'AVAILABLE', 'FILLED', 'ACTIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE shift_application_status AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

CREATE TABLE shift_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  weekdays smallint[] NOT NULL CHECK (array_length(weekdays, 1) BETWEEN 1 AND 7),
  local_start_time time NOT NULL,
  local_end_time time NOT NULL,
  headcount integer NOT NULL DEFAULT 1 CHECK (headcount BETWEEN 1 AND 50),
  checkin_open_minutes integer NOT NULL DEFAULT 30 CHECK (checkin_open_minutes BETWEEN 0 AND 240),
  checkin_tolerance_minutes integer NOT NULL DEFAULT 10 CHECK (checkin_tolerance_minutes BETWEEN 0 AND 240),
  checkin_radius_m integer NOT NULL DEFAULT 250 CHECK (checkin_radius_m BETWEEN 0 AND 5000),
  search_radius_m integer NOT NULL DEFAULT 5000 CHECK (search_radius_m BETWEEN 100 AND 100000),
  compensation_cents integer NOT NULL DEFAULT 0 CHECK (compensation_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'BRL',
  requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  auto_approve_substitutes boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, store_id, name),
  FOREIGN KEY (store_id, tenant_id) REFERENCES stores(id, tenant_id) ON DELETE RESTRICT,
  CHECK (weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[])
);

CREATE TABLE shift_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id uuid NOT NULL,
  template_id uuid,
  label text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 120),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  checkin_opens_at timestamptz NOT NULL,
  checkin_deadline_at timestamptz NOT NULL,
  checkin_radius_m integer NOT NULL DEFAULT 250 CHECK (checkin_radius_m BETWEEN 0 AND 5000),
  search_radius_m integer NOT NULL DEFAULT 5000 CHECK (search_radius_m BETWEEN 100 AND 100000),
  compensation_cents integer NOT NULL DEFAULT 0 CHECK (compensation_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'BRL',
  requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  auto_approve_substitutes boolean NOT NULL DEFAULT true,
  status shift_slot_status NOT NULL DEFAULT 'SCHEDULED',
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (store_id, tenant_id) REFERENCES stores(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (template_id, tenant_id) REFERENCES shift_templates(id, tenant_id) ON DELETE RESTRICT,
  CHECK (ends_at > starts_at),
  CHECK (checkin_opens_at <= starts_at),
  CHECK (checkin_deadline_at >= starts_at AND checkin_deadline_at < ends_at)
);

CREATE INDEX shift_slots_operation_idx
  ON shift_slots (tenant_id, store_id, starts_at, status);

CREATE TABLE shift_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  slot_id uuid NOT NULL,
  position_number integer NOT NULL CHECK (position_number > 0),
  holder_courier_id uuid REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  assigned_courier_id uuid REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  status shift_position_status NOT NULL DEFAULT 'AVAILABLE',
  checkin_at timestamptz,
  checkin_latitude double precision CHECK (checkin_latitude BETWEEN -90 AND 90),
  checkin_longitude double precision CHECK (checkin_longitude BETWEEN -180 AND 180),
  checkin_accuracy double precision CHECK (checkin_accuracy > 0 AND checkin_accuracy <= 1000),
  checkin_distance_m double precision CHECK (checkin_distance_m >= 0),
  checkout_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, slot_id, position_number),
  FOREIGN KEY (slot_id, tenant_id) REFERENCES shift_slots(id, tenant_id) ON DELETE CASCADE,
  CHECK (status NOT IN ('FILLED', 'ACTIVE', 'COMPLETED') OR assigned_courier_id IS NOT NULL),
  CHECK (status <> 'RESERVED' OR holder_courier_id IS NOT NULL),
  CHECK (checkin_at IS NULL OR assigned_courier_id IS NOT NULL)
);

CREATE INDEX shift_positions_slot_idx ON shift_positions (tenant_id, slot_id, status);
CREATE INDEX shift_positions_courier_idx
  ON shift_positions (tenant_id, assigned_courier_id, status)
  WHERE assigned_courier_id IS NOT NULL;
CREATE UNIQUE INDEX shift_positions_one_active_per_courier_idx
  ON shift_positions (assigned_courier_id)
  WHERE assigned_courier_id IS NOT NULL AND status = 'ACTIVE';

CREATE TABLE shift_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  position_id uuid NOT NULL,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  status shift_application_status NOT NULL DEFAULT 'PENDING',
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, position_id, courier_profile_id),
  FOREIGN KEY (position_id, tenant_id) REFERENCES shift_positions(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX shift_applications_review_idx
  ON shift_applications (tenant_id, position_id, status, created_at);

CREATE TABLE shift_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  slot_id uuid NOT NULL,
  position_id uuid,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 3 AND 80),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (slot_id, tenant_id) REFERENCES shift_slots(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (position_id, tenant_id) REFERENCES shift_positions(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX shift_events_timeline_idx
  ON shift_events (tenant_id, slot_id, occurred_at, id);

CREATE TRIGGER shift_templates_touch_updated_at BEFORE UPDATE ON shift_templates
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER shift_slots_touch_updated_at BEFORE UPDATE ON shift_slots
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER shift_positions_touch_updated_at BEFORE UPDATE ON shift_positions
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER shift_applications_touch_updated_at BEFORE UPDATE ON shift_applications
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();

ALTER TABLE shift_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_templates_isolation ON shift_templates
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE shift_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_slots FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_slots_isolation ON shift_slots
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE shift_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_positions FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_positions_isolation ON shift_positions
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE shift_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_applications_isolation ON shift_applications
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE shift_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_events FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_events_isolation ON shift_events
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON shift_templates TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE ON shift_slots TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE ON shift_positions TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE ON shift_applications TO rastreia_runtime;
GRANT SELECT, INSERT ON shift_events TO rastreia_runtime;
