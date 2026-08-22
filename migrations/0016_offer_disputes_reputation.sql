SET search_path TO rastreia, public;

CREATE TYPE offer_dispute_status AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED');
CREATE TYPE offer_dispute_category AS ENUM ('SERVICE', 'PUNCTUALITY', 'PAYMENT', 'CANCELLATION', 'CONDUCT', 'OTHER');
CREATE TYPE offer_dispute_outcome AS ENUM ('STORE_FAVORED', 'COURIER_FAVORED', 'NO_FAULT', 'AGREEMENT', 'DISMISSED');
CREATE TYPE offer_dispute_evidence_type AS ENUM ('NOTE', 'URL');

CREATE TABLE offer_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  offer_id uuid NOT NULL,
  store_id uuid NOT NULL,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  status offer_dispute_status NOT NULL DEFAULT 'OPEN',
  category offer_dispute_category NOT NULL,
  description text NOT NULL CHECK (char_length(description) BETWEEN 10 AND 2000),
  opened_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  opened_by_role tenant_role NOT NULL,
  response_due_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
  review_started_at timestamptz,
  outcome offer_dispute_outcome,
  resolution_notes text CHECK (resolution_notes IS NULL OR char_length(resolution_notes) BETWEEN 10 AND 2000),
  resolved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (offer_id, tenant_id) REFERENCES delivery_offers(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (store_id, tenant_id) REFERENCES stores(id, tenant_id) ON DELETE RESTRICT,
  CHECK ((status = 'RESOLVED') = (outcome IS NOT NULL AND resolution_notes IS NOT NULL AND resolved_at IS NOT NULL))
);

CREATE UNIQUE INDEX offer_disputes_one_active_offer_idx
  ON offer_disputes (tenant_id, offer_id) WHERE status IN ('OPEN', 'UNDER_REVIEW');
CREATE INDEX offer_disputes_queue_idx
  ON offer_disputes (tenant_id, status, response_due_at, store_id);

CREATE TABLE offer_dispute_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  dispute_id uuid NOT NULL,
  evidence_type offer_dispute_evidence_type NOT NULL,
  content text NOT NULL CHECK (char_length(content) BETWEEN 3 AND 2000),
  submitted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_by_role tenant_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (dispute_id, tenant_id) REFERENCES offer_disputes(id, tenant_id) ON DELETE RESTRICT,
  CHECK (evidence_type <> 'URL' OR content ~* '^https?://')
);

CREATE INDEX offer_dispute_evidence_timeline_idx
  ON offer_dispute_evidence (tenant_id, dispute_id, created_at);

CREATE TABLE offer_dispute_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  dispute_id uuid NOT NULL,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 3 AND 80),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (dispute_id, tenant_id) REFERENCES offer_disputes(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX offer_dispute_events_timeline_idx
  ON offer_dispute_events (tenant_id, dispute_id, created_at);

CREATE TABLE courier_marketplace_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  store_id uuid,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  active_until timestamptz,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason text CHECK (revoke_reason IS NULL OR char_length(revoke_reason) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (store_id, tenant_id) REFERENCES stores(id, tenant_id) ON DELETE RESTRICT,
  CHECK (active_until IS NULL OR active_until > created_at)
);

CREATE INDEX courier_marketplace_blocks_active_idx
  ON courier_marketplace_blocks (tenant_id, courier_profile_id, store_id, active_until)
  WHERE revoked_at IS NULL;

CREATE FUNCTION courier_is_marketplace_eligible(p_tenant_id uuid, p_courier_id uuid, p_store_id uuid)
RETURNS boolean AS $$
  SELECT
    NOT EXISTS (
      SELECT 1 FROM courier_marketplace_blocks block
      WHERE block.tenant_id = p_tenant_id AND block.courier_profile_id = p_courier_id
        AND (block.store_id IS NULL OR block.store_id = p_store_id)
        AND block.revoked_at IS NULL AND (block.active_until IS NULL OR block.active_until > now())
    )
    AND (
      (SELECT count(*) FROM delivery_offers offer
       WHERE offer.tenant_id = p_tenant_id AND offer.winner_courier_id = p_courier_id
         AND (offer.status = 'COMPLETED' OR (offer.status = 'CANCELLED' AND offer.cancelled_by_role = 'COURIER'))) < 5
      OR
      (SELECT count(*) FILTER (WHERE offer.status = 'COMPLETED')::numeric / NULLIF(count(*), 0)
       FROM delivery_offers offer
       WHERE offer.tenant_id = p_tenant_id AND offer.winner_courier_id = p_courier_id
         AND (offer.status = 'COMPLETED' OR (offer.status = 'CANCELLED' AND offer.cancelled_by_role = 'COURIER'))) >= 0.80
    )
    AND (
      (SELECT count(*) FROM delivery_offers offer JOIN deliveries delivery ON delivery.id = offer.delivery_id
       WHERE offer.tenant_id = p_tenant_id AND offer.winner_courier_id = p_courier_id
         AND offer.status = 'COMPLETED' AND offer.delivery_window_end IS NOT NULL) < 5
      OR
      (SELECT count(*) FILTER (WHERE delivery.delivered_at <= offer.delivery_window_end)::numeric / NULLIF(count(*), 0)
       FROM delivery_offers offer JOIN deliveries delivery ON delivery.id = offer.delivery_id
       WHERE offer.tenant_id = p_tenant_id AND offer.winner_courier_id = p_courier_id
         AND offer.status = 'COMPLETED' AND offer.delivery_window_end IS NOT NULL) >= 0.70
    );
$$ LANGUAGE sql STABLE;

CREATE TRIGGER offer_disputes_touch_updated_at BEFORE UPDATE ON offer_disputes
  FOR EACH ROW EXECUTE PROCEDURE touch_updated_at();

ALTER TABLE offer_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_disputes FORCE ROW LEVEL SECURITY;
ALTER TABLE offer_dispute_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_dispute_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE offer_dispute_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_dispute_events FORCE ROW LEVEL SECURITY;
ALTER TABLE courier_marketplace_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_marketplace_blocks FORCE ROW LEVEL SECURITY;

CREATE POLICY offer_disputes_tenant_policy ON offer_disputes
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY offer_dispute_evidence_tenant_policy ON offer_dispute_evidence
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY offer_dispute_events_tenant_policy ON offer_dispute_events
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY courier_marketplace_blocks_tenant_policy ON courier_marketplace_blocks
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON offer_disputes TO rastreia_runtime;
GRANT SELECT, INSERT ON offer_dispute_evidence TO rastreia_runtime;
GRANT SELECT, INSERT ON offer_dispute_events TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE ON courier_marketplace_blocks TO rastreia_runtime;
