SET LOCAL search_path TO rastreia, public;

CREATE TYPE shift_confirmation_status AS ENUM ('PENDING', 'CONFIRMED', 'DECLINED', 'EXPIRED');
CREATE TYPE shift_change_request_type AS ENUM ('WITHDRAWAL', 'SUBSTITUTION', 'TRANSFER');
CREATE TYPE shift_change_request_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'RESOLVED');

ALTER TABLE shift_templates
  ADD COLUMN confirmation_lead_minutes integer NOT NULL DEFAULT 1440
    CHECK (confirmation_lead_minutes BETWEEN 30 AND 10080),
  ADD COLUMN withdrawal_notice_minutes integer NOT NULL DEFAULT 720
    CHECK (withdrawal_notice_minutes BETWEEN 0 AND 10080);

ALTER TABLE shift_slots
  ADD COLUMN confirmation_lead_minutes integer NOT NULL DEFAULT 1440
    CHECK (confirmation_lead_minutes BETWEEN 30 AND 10080),
  ADD COLUMN withdrawal_notice_minutes integer NOT NULL DEFAULT 720
    CHECK (withdrawal_notice_minutes BETWEEN 0 AND 10080),
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancellation_reason text CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) BETWEEN 3 AND 500);

ALTER TABLE shift_positions
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancellation_reason text CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) BETWEEN 3 AND 500);

CREATE TABLE shift_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  position_id uuid NOT NULL,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  status shift_confirmation_status NOT NULL DEFAULT 'PENDING',
  due_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, position_id, courier_profile_id),
  FOREIGN KEY (position_id, tenant_id) REFERENCES shift_positions(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX shift_confirmations_pending_idx ON shift_confirmations (status, due_at)
  WHERE status = 'PENDING';

CREATE TABLE shift_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  position_id uuid NOT NULL,
  request_type shift_change_request_type NOT NULL,
  requester_courier_id uuid REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  suggested_courier_id uuid REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  status shift_change_request_status NOT NULL DEFAULT 'PENDING',
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  notice_minutes integer NOT NULL DEFAULT 0 CHECK (notice_minutes >= 0),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 3 AND 500),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (position_id, tenant_id) REFERENCES shift_positions(id, tenant_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX shift_change_requests_one_pending_idx
  ON shift_change_requests (tenant_id, position_id)
  WHERE status = 'PENDING';
CREATE INDEX shift_change_requests_review_idx
  ON shift_change_requests (tenant_id, status, created_at);

CREATE TRIGGER shift_confirmations_touch_updated_at BEFORE UPDATE ON shift_confirmations
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER shift_change_requests_touch_updated_at BEFORE UPDATE ON shift_change_requests
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();

ALTER TABLE shift_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_confirmations_isolation ON shift_confirmations
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE shift_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_change_requests_isolation ON shift_change_requests
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON shift_confirmations TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE ON shift_change_requests TO rastreia_runtime;
