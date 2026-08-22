SET LOCAL search_path TO rastreia, public;

CREATE TYPE courier_availability_status AS ENUM ('AVAILABLE', 'UNAVAILABLE');
CREATE TYPE shift_search_status AS ENUM ('SEARCHING', 'FILLED', 'EXHAUSTED', 'CANCELLED');
CREATE TYPE shift_search_wave_status AS ENUM ('ACTIVE', 'CLOSED', 'EXPIRED');
CREATE TYPE shift_search_candidate_status AS ENUM ('NOTIFIED', 'ACCEPTED', 'LOST', 'EXPIRED');

ALTER TABLE shift_templates ADD COLUMN generated_through date;
ALTER TABLE shift_slots ADD COLUMN occurrence_date date;
ALTER TABLE shift_slots ADD CONSTRAINT shift_slots_template_occurrence_unique
  UNIQUE (tenant_id, template_id, occurrence_date);

CREATE TABLE shift_template_holders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  template_id uuid NOT NULL,
  position_number integer NOT NULL CHECK (position_number > 0),
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, template_id, position_number),
  UNIQUE (tenant_id, template_id, courier_profile_id),
  FOREIGN KEY (template_id, tenant_id) REFERENCES shift_templates(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE courier_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  status courier_availability_status NOT NULL DEFAULT 'UNAVAILABLE',
  latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude BETWEEN -180 AND 180),
  accuracy double precision CHECK (accuracy > 0 AND accuracy <= 1000),
  interest_radius_m integer NOT NULL DEFAULT 5000 CHECK (interest_radius_m BETWEEN 500 AND 100000),
  available_until timestamptz,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, courier_profile_id),
  CHECK (status = 'UNAVAILABLE' OR (latitude IS NOT NULL AND longitude IS NOT NULL AND accuracy IS NOT NULL))
);

CREATE INDEX courier_availability_search_idx
  ON courier_availability (tenant_id, status, available_until);

CREATE TABLE shift_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  position_id uuid NOT NULL,
  status shift_search_status NOT NULL DEFAULT 'SEARCHING',
  current_wave integer NOT NULL DEFAULT 0 CHECK (current_wave >= 0),
  initial_radius_m integer NOT NULL DEFAULT 2000 CHECK (initial_radius_m BETWEEN 100 AND 100000),
  radius_step_m integer NOT NULL DEFAULT 2000 CHECK (radius_step_m BETWEEN 100 AND 100000),
  max_radius_m integer NOT NULL CHECK (max_radius_m BETWEEN 100 AND 100000),
  wave_duration_seconds integer NOT NULL DEFAULT 120 CHECK (wave_duration_seconds BETWEEN 30 AND 3600),
  expires_at timestamptz NOT NULL,
  winner_courier_id uuid REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, position_id),
  FOREIGN KEY (position_id, tenant_id) REFERENCES shift_positions(id, tenant_id) ON DELETE CASCADE,
  CHECK (max_radius_m >= initial_radius_m)
);

CREATE INDEX shift_searches_pending_idx ON shift_searches (status, expires_at)
  WHERE status = 'SEARCHING';

CREATE TABLE shift_search_waves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  search_id uuid NOT NULL,
  wave_number integer NOT NULL CHECK (wave_number > 0),
  radius_m integer NOT NULL CHECK (radius_m BETWEEN 100 AND 100000),
  status shift_search_wave_status NOT NULL DEFAULT 'ACTIVE',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closes_at timestamptz NOT NULL,
  closed_at timestamptz,
  candidate_count integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, search_id, wave_number),
  FOREIGN KEY (search_id, tenant_id) REFERENCES shift_searches(id, tenant_id) ON DELETE CASCADE,
  CHECK (closes_at > opened_at)
);

CREATE INDEX shift_search_waves_active_idx ON shift_search_waves (status, closes_at)
  WHERE status = 'ACTIVE';

CREATE TABLE shift_search_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  search_id uuid NOT NULL,
  wave_id uuid NOT NULL,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  distance_m double precision NOT NULL CHECK (distance_m >= 0),
  status shift_search_candidate_status NOT NULL DEFAULT 'NOTIFIED',
  notified_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, search_id, courier_profile_id),
  FOREIGN KEY (search_id, tenant_id) REFERENCES shift_searches(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (wave_id, tenant_id) REFERENCES shift_search_waves(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX shift_search_candidates_courier_idx
  ON shift_search_candidates (tenant_id, courier_profile_id, status, notified_at DESC);

CREATE TRIGGER courier_availability_touch_updated_at BEFORE UPDATE ON courier_availability
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER shift_searches_touch_updated_at BEFORE UPDATE ON shift_searches
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();

ALTER TABLE shift_template_holders ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_template_holders FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_template_holders_isolation ON shift_template_holders
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE courier_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_availability FORCE ROW LEVEL SECURITY;
CREATE POLICY courier_availability_isolation ON courier_availability
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE shift_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_searches FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_searches_isolation ON shift_searches
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE shift_search_waves ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_search_waves FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_search_waves_isolation ON shift_search_waves
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE shift_search_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_search_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_search_candidates_isolation ON shift_search_candidates
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON shift_template_holders TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE ON courier_availability TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE ON shift_searches TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE ON shift_search_waves TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE ON shift_search_candidates TO rastreia_runtime;
