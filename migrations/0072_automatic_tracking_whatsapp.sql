SET LOCAL search_path TO rastreia, public;
SET LOCAL lock_timeout TO '5s';

-- Manual sharing and the automatic notice may coexist without breaking links.
-- Explicit revoke still updates every active token of the delivery.
DROP INDEX tracking_tokens_active_delivery_idx;
CREATE INDEX tracking_tokens_active_delivery_idx ON tracking_tokens(tenant_id,delivery_id) WHERE revoked_at IS NULL;

-- PostgreSQL 9.6 disallows ALTER TYPE ... ADD VALUE in a transaction.
-- Recreate the enum and cast existing rows without changing their status.
DROP INDEX message_deliveries_pending_idx;
ALTER TABLE message_deliveries ALTER COLUMN status DROP DEFAULT;
ALTER TYPE message_delivery_status RENAME TO message_delivery_status_0072_old;
CREATE TYPE message_delivery_status AS ENUM ('PENDING','PROCESSING','RETRYING','SENT','DELIVERED','FAILED','SKIPPED','UNKNOWN');
ALTER TABLE message_deliveries ALTER COLUMN status TYPE message_delivery_status USING status::text::message_delivery_status;
ALTER TABLE message_deliveries ALTER COLUMN status SET DEFAULT 'PENDING';
DROP TYPE message_delivery_status_0072_old;
CREATE INDEX message_deliveries_pending_idx ON message_deliveries(status,next_attempt_at)
  WHERE status IN ('PENDING','RETRYING');
ALTER TABLE message_deliveries
  ADD COLUMN purpose text,
  ADD COLUMN trigger_source text CHECK (trigger_source IN ('AUTOMATIC','MANUAL')),
  ADD COLUMN tracking_token_id uuid REFERENCES tracking_tokens(id),
  ADD COLUMN provider_phone_number_id text;
-- A single logical notice per delivery, even across workers and manual clicks.
CREATE UNIQUE INDEX message_delivery_purpose_unique
  ON message_deliveries(tenant_id,delivery_id,channel,purpose) WHERE purpose IS NOT NULL;
CREATE UNIQUE INDEX message_provider_id_unique
  ON message_deliveries(provider_message_id) WHERE provider_message_id IS NOT NULL;
