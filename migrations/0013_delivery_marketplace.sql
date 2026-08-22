SET search_path TO rastreia, public;

CREATE TYPE delivery_offer_status AS ENUM ('PUBLISHED', 'ACCEPTED', 'COMPLETED', 'EXPIRED', 'CANCELLED');
CREATE TYPE offer_candidate_status AS ENUM ('NOTIFIED', 'ACCEPTED', 'LOST', 'EXPIRED');

CREATE TABLE delivery_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  status delivery_offer_status NOT NULL DEFAULT 'PUBLISHED',
  payout_cents integer NOT NULL CHECK (payout_cents > 0),
  currency char(3) NOT NULL DEFAULT 'BRL',
  estimated_distance_m integer NOT NULL CHECK (estimated_distance_m > 0),
  estimated_duration_minutes integer NOT NULL CHECK (estimated_duration_minutes > 0),
  pickup_window_start timestamptz NOT NULL,
  pickup_window_end timestamptz NOT NULL,
  delivery_window_end timestamptz,
  expires_at timestamptz NOT NULL,
  search_radius_m integer NOT NULL DEFAULT 10000 CHECK (search_radius_m BETWEEN 500 AND 100000),
  volume_type text NOT NULL DEFAULT 'SMALL' CHECK (volume_type IN ('DOCUMENT', 'SMALL', 'MEDIUM', 'LARGE')),
  approximate_region text NOT NULL CHECK (char_length(approximate_region) BETWEEN 2 AND 160),
  requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  winner_courier_id uuid REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  accepted_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, delivery_id),
  FOREIGN KEY (store_id, tenant_id) REFERENCES stores(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (delivery_id, tenant_id) REFERENCES deliveries(id, tenant_id) ON DELETE RESTRICT,
  CHECK (pickup_window_end > pickup_window_start),
  CHECK (delivery_window_end IS NULL OR delivery_window_end > pickup_window_start),
  CHECK (expires_at > created_at),
  CHECK (status <> 'ACCEPTED' OR (winner_courier_id IS NOT NULL AND accepted_at IS NOT NULL))
);

CREATE INDEX delivery_offers_market_idx
  ON delivery_offers (tenant_id, status, expires_at, store_id);

CREATE TABLE offer_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  offer_id uuid NOT NULL,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  distance_to_pickup_m double precision NOT NULL CHECK (distance_to_pickup_m >= 0),
  status offer_candidate_status NOT NULL DEFAULT 'NOTIFIED',
  notified_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, offer_id, courier_profile_id),
  FOREIGN KEY (offer_id, tenant_id) REFERENCES delivery_offers(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX offer_candidates_courier_idx
  ON offer_candidates (tenant_id, courier_profile_id, status, created_at);

CREATE TABLE delivery_offer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  offer_id uuid NOT NULL,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 2 AND 80),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (offer_id, tenant_id) REFERENCES delivery_offers(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX delivery_offer_events_timeline_idx
  ON delivery_offer_events (tenant_id, offer_id, created_at);

CREATE TRIGGER delivery_offers_touch_updated_at BEFORE UPDATE ON delivery_offers
  FOR EACH ROW EXECUTE PROCEDURE touch_updated_at();
CREATE TRIGGER offer_candidates_touch_updated_at BEFORE UPDATE ON offer_candidates
  FOR EACH ROW EXECUTE PROCEDURE touch_updated_at();

ALTER TABLE delivery_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_offers FORCE ROW LEVEL SECURITY;
ALTER TABLE offer_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery_offer_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_offer_events FORCE ROW LEVEL SECURITY;

CREATE POLICY delivery_offers_tenant_policy ON delivery_offers
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY offer_candidates_tenant_policy ON offer_candidates
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY delivery_offer_events_tenant_policy ON delivery_offer_events
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON delivery_offers TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON offer_candidates TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON delivery_offer_events TO rastreia_runtime;
