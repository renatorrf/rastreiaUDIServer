SET LOCAL search_path TO rastreia, public;

CREATE TABLE customer_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  customer_profile_id uuid NOT NULL,
  endpoint text NOT NULL,
  endpoint_hash char(64) NOT NULL,
  p256dh text NOT NULL,
  auth_secret text NOT NULL,
  expiration_time timestamptz,
  user_agent text,
  active boolean NOT NULL DEFAULT true,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (customer_profile_id, tenant_id)
    REFERENCES customer_profiles(id, tenant_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, customer_profile_id, endpoint_hash)
);

CREATE INDEX customer_push_subscriptions_active_idx
  ON customer_push_subscriptions (tenant_id, customer_profile_id, active);

CREATE TRIGGER customer_push_subscriptions_touch_updated_at
BEFORE UPDATE ON customer_push_subscriptions
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();

ALTER TABLE customer_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_push_subscriptions_tenant ON customer_push_subscriptions
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_push_subscriptions TO rastreia_runtime;
