SET search_path TO rastreia, public;

CREATE TYPE offer_financial_entry_type AS ENUM ('COMPLETION', 'CANCELLATION_COMPENSATION');

ALTER TABLE delivery_offers
  DROP CONSTRAINT delivery_offers_tenant_id_delivery_id_key;
ALTER TABLE delivery_offers
  ADD COLUMN cancellation_reason text,
  ADD COLUMN cancellation_fee_cents integer NOT NULL DEFAULT 0 CHECK (cancellation_fee_cents >= 0),
  ADD COLUMN cancelled_by_role tenant_role;

CREATE UNIQUE INDEX delivery_offers_one_active_per_delivery_idx
  ON delivery_offers (tenant_id, delivery_id)
  WHERE status IN ('PUBLISHED', 'ACCEPTED');

CREATE TABLE offer_price_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  offer_id uuid NOT NULL,
  previous_payout_cents integer NOT NULL CHECK (previous_payout_cents > 0),
  new_payout_cents integer NOT NULL CHECK (new_payout_cents > 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (offer_id, tenant_id) REFERENCES delivery_offers(id, tenant_id) ON DELETE CASCADE,
  CHECK (new_payout_cents <> previous_payout_cents)
);

CREATE INDEX offer_price_revisions_timeline_idx
  ON offer_price_revisions (tenant_id, offer_id, created_at);

CREATE TABLE offer_financial_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  offer_id uuid NOT NULL,
  store_id uuid NOT NULL,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id) ON DELETE RESTRICT,
  entry_type offer_financial_entry_type NOT NULL,
  store_cost_cents integer NOT NULL CHECK (store_cost_cents >= 0),
  courier_earning_cents integer NOT NULL CHECK (courier_earning_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'BRL',
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 240),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, offer_id, entry_type),
  FOREIGN KEY (offer_id, tenant_id) REFERENCES delivery_offers(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (store_id, tenant_id) REFERENCES stores(id, tenant_id) ON DELETE RESTRICT,
  CHECK (store_cost_cents > 0 OR courier_earning_cents > 0)
);

CREATE INDEX offer_financial_entries_statement_idx
  ON offer_financial_entries (tenant_id, occurred_at DESC, store_id, courier_profile_id);

CREATE FUNCTION reject_offer_financial_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'offer financial entries are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER offer_financial_entries_immutable_update
  BEFORE UPDATE ON offer_financial_entries FOR EACH ROW EXECUTE PROCEDURE reject_offer_financial_mutation();
CREATE TRIGGER offer_financial_entries_immutable_delete
  BEFORE DELETE ON offer_financial_entries FOR EACH ROW EXECUTE PROCEDURE reject_offer_financial_mutation();

ALTER TABLE offer_price_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_price_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE offer_financial_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_financial_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY offer_price_revisions_tenant_policy ON offer_price_revisions
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY offer_financial_entries_tenant_policy ON offer_financial_entries
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON offer_price_revisions TO rastreia_runtime;
GRANT SELECT, INSERT ON offer_financial_entries TO rastreia_runtime;
