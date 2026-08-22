SET LOCAL search_path TO rastreia, public;

CREATE TYPE incident_type AS ENUM (
  'DELIVERY_FAILURE', 'RECIPIENT_ABSENT', 'RECIPIENT_REFUSAL', 'DAMAGE',
  'ADDRESS_ISSUE', 'TRACKING_LOSS', 'RETURN', 'OTHER'
);
CREATE TYPE incident_severity AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE incident_status AS ENUM ('OPEN', 'UNDER_REVIEW', 'RETURN_IN_PROGRESS', 'RESOLVED');
CREATE TYPE incident_resolution AS ENUM ('RETURN_TO_STORE', 'NO_RETURN', 'RETRY_PLANNED', 'CUSTOMER_CANCELLED');

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  store_id uuid NOT NULL,
  type incident_type NOT NULL,
  severity incident_severity NOT NULL DEFAULT 'MEDIUM',
  status incident_status NOT NULL DEFAULT 'OPEN',
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 2000),
  source_delivery_version integer CHECK (source_delivery_version IS NULL OR source_delivery_version >= 0),
  resolution incident_resolution,
  resolution_notes text CHECK (resolution_notes IS NULL OR char_length(resolution_notes) BETWEEN 3 AND 2000),
  return_started_at timestamptz,
  resolved_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, delivery_id, source_delivery_version),
  FOREIGN KEY (delivery_id, tenant_id) REFERENCES deliveries(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (store_id, tenant_id) REFERENCES stores(id, tenant_id) ON DELETE RESTRICT,
  CHECK (status <> 'RETURN_IN_PROGRESS' OR (return_started_at IS NOT NULL AND resolution = 'RETURN_TO_STORE')),
  CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL))
);

CREATE INDEX incidents_queue_idx ON incidents (tenant_id, status, severity, created_at DESC);
CREATE INDEX incidents_delivery_idx ON incidents (tenant_id, delivery_id, created_at DESC);
CREATE INDEX incidents_store_idx ON incidents (tenant_id, store_id, status, created_at DESC);

CREATE TABLE incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  incident_id uuid NOT NULL,
  event_type text NOT NULL,
  from_status incident_status,
  to_status incident_status NOT NULL,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  incident_version integer NOT NULL CHECK (incident_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, incident_version),
  FOREIGN KEY (incident_id, tenant_id) REFERENCES incidents(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX incident_events_timeline_idx ON incident_events (tenant_id, incident_id, incident_version);

CREATE TABLE incident_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  incident_id uuid NOT NULL,
  object_url text NOT NULL,
  object_key text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  checksum_sha256 char(64) NOT NULL,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, object_key),
  UNIQUE (tenant_id, incident_id, checksum_sha256),
  FOREIGN KEY (incident_id, tenant_id) REFERENCES incidents(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX incident_evidence_timeline_idx ON incident_evidence (tenant_id, incident_id, created_at DESC);

CREATE TRIGGER incidents_touch_updated_at BEFORE UPDATE ON incidents
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();

ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY incidents_isolation ON incidents
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE incident_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_events FORCE ROW LEVEL SECURITY;
CREATE POLICY incident_events_isolation ON incident_events
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE incident_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY incident_evidence_isolation ON incident_evidence
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON incidents TO rastreia_runtime;
GRANT SELECT, INSERT ON incident_events, incident_evidence TO rastreia_runtime;
