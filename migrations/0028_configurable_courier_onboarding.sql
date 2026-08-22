SET LOCAL search_path TO rastreia, public;

CREATE TYPE onboarding_submission_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');
CREATE TYPE courier_vehicle_status AS ENUM ('ACTIVE', 'INACTIVE');

CREATE TABLE onboarding_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,49}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 120),
  description text,
  required boolean NOT NULL DEFAULT false,
  requires_review boolean NOT NULL DEFAULT true,
  requires_expiry boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 10000),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (id, tenant_id)
);

CREATE TABLE courier_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  type_label text NOT NULL CHECK (char_length(type_label) BETWEEN 2 AND 80),
  plate_masked text,
  plate_hash char(64),
  capacity_kg numeric(8,2) CHECK (capacity_kg > 0 AND capacity_kg <= 100000),
  notes text,
  status courier_vehicle_status NOT NULL DEFAULT 'ACTIVE',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, courier_profile_id, plate_hash),
  UNIQUE (id, tenant_id)
);

CREATE TABLE courier_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  requirement_id uuid NOT NULL,
  object_url text NOT NULL,
  object_key text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  checksum_sha256 char(64) NOT NULL,
  expires_at date,
  status onboarding_submission_status NOT NULL DEFAULT 'PENDING',
  review_notes text,
  submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (requirement_id, tenant_id) REFERENCES onboarding_requirements(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (id, tenant_id)
);

CREATE TABLE onboarding_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  entity_type text NOT NULL CHECK (entity_type IN ('requirement', 'document', 'vehicle')),
  entity_id uuid NOT NULL,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX onboarding_requirements_active_idx
  ON onboarding_requirements (tenant_id, active, sort_order, label);
CREATE INDEX courier_vehicles_profile_idx
  ON courier_vehicles (tenant_id, courier_profile_id, status);
CREATE INDEX courier_documents_profile_idx
  ON courier_documents (tenant_id, courier_profile_id, requirement_id, created_at DESC);
CREATE INDEX courier_documents_review_idx
  ON courier_documents (tenant_id, status, created_at) WHERE status = 'PENDING';
CREATE INDEX onboarding_events_profile_idx
  ON onboarding_events (tenant_id, courier_profile_id, created_at DESC);

CREATE TRIGGER onboarding_requirements_touch_updated_at BEFORE UPDATE ON onboarding_requirements
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER courier_vehicles_touch_updated_at BEFORE UPDATE ON courier_vehicles
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER courier_documents_touch_updated_at BEFORE UPDATE ON courier_documents
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();

ALTER TABLE onboarding_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_requirements FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_requirements_isolation ON onboarding_requirements
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE courier_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_vehicles FORCE ROW LEVEL SECURITY;
CREATE POLICY courier_vehicles_isolation ON courier_vehicles
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE courier_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY courier_documents_isolation ON courier_documents
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE onboarding_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_events FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_events_isolation ON onboarding_events
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON onboarding_requirements TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE ON courier_vehicles TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE ON courier_documents TO rastreia_runtime;
GRANT SELECT, INSERT ON onboarding_events TO rastreia_runtime;
