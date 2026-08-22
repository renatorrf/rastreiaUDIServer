SET LOCAL search_path TO rastreia, public;

CREATE TYPE notification_channel AS ENUM ('WEB_PUSH', 'WHATSAPP', 'SMS');
CREATE TYPE message_delivery_status AS ENUM ('PENDING', 'PROCESSING', 'RETRYING', 'SENT', 'DELIVERED', 'FAILED');

CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  endpoint_hash char(64) NOT NULL,
  p256dh text NOT NULL,
  auth_secret text NOT NULL,
  expiration_time timestamptz,
  preferences jsonb NOT NULL DEFAULT '{"delivery": true}'::jsonb,
  user_agent text,
  active boolean NOT NULL DEFAULT true,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, endpoint_hash)
);

CREATE INDEX push_subscriptions_user_active_idx
  ON push_subscriptions (tenant_id, user_id, active);

CREATE TABLE message_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  channel notification_channel NOT NULL CHECK (channel IN ('WHATSAPP', 'SMS')),
  status message_delivery_status NOT NULL DEFAULT 'PENDING',
  destination_masked text NOT NULL,
  encrypted_payload text NOT NULL,
  provider_message_id text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (delivery_id, tenant_id) REFERENCES deliveries(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX message_deliveries_timeline_idx
  ON message_deliveries (tenant_id, delivery_id, created_at DESC);
CREATE INDEX message_deliveries_pending_idx
  ON message_deliveries (status, next_attempt_at)
  WHERE status IN ('PENDING', 'RETRYING');

CREATE TABLE notification_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  channel notification_channel NOT NULL,
  message_delivery_id uuid,
  push_subscription_id uuid,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  success boolean NOT NULL,
  provider_status integer,
  provider_message_id text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (message_delivery_id, tenant_id) REFERENCES message_deliveries(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (push_subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  CHECK ((message_delivery_id IS NOT NULL)::integer + (push_subscription_id IS NOT NULL)::integer = 1)
);

CREATE INDEX notification_attempts_message_idx
  ON notification_attempts (tenant_id, message_delivery_id, created_at DESC);

CREATE TABLE message_webhook_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  payload_hash char(64) NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE delivery_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  object_url text NOT NULL,
  object_key text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  checksum_sha256 char(64) NOT NULL,
  recipient_name text CHECK (recipient_name IS NULL OR char_length(recipient_name) BETWEEN 2 AND 160),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  public_visible boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, object_key),
  UNIQUE (tenant_id, delivery_id, checksum_sha256),
  FOREIGN KEY (delivery_id, tenant_id) REFERENCES deliveries(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX delivery_proofs_delivery_idx
  ON delivery_proofs (tenant_id, delivery_id, created_at DESC);

CREATE TRIGGER push_subscriptions_touch_updated_at BEFORE UPDATE ON push_subscriptions
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();
CREATE TRIGGER message_deliveries_touch_updated_at BEFORE UPDATE ON message_deliveries
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY push_subscriptions_isolation ON push_subscriptions
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE message_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY message_deliveries_isolation ON message_deliveries
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE notification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_attempts_isolation ON notification_attempts
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

ALTER TABLE delivery_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_proofs FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_proofs_isolation ON delivery_proofs
  USING (tenant_id = rastreia.current_tenant_id())
  WITH CHECK (tenant_id = rastreia.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO rastreia_runtime;
GRANT SELECT, INSERT, UPDATE ON message_deliveries TO rastreia_runtime;
GRANT SELECT, INSERT ON notification_attempts TO rastreia_runtime;
GRANT SELECT, INSERT ON delivery_proofs TO rastreia_runtime;
