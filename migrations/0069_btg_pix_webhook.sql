SET LOCAL search_path=rastreia,public;
-- One registered application webhook belongs to one company configuration.
CREATE UNIQUE INDEX company_btg_webhook_id_unique ON company_service_settings ((lower(nullif(public_config->>'webhookId','')))) WHERE provider='BTG';
CREATE TABLE btg_pix_webhook_receipts (
 company_id uuid NOT NULL REFERENCES companies(id),
 event_key text NOT NULL CHECK(length(event_key)=64),
 order_id uuid NOT NULL REFERENCES commerce_pix_payments(order_id),
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,event_key)
);
ALTER TABLE btg_pix_webhook_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE btg_pix_webhook_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON btg_pix_webhook_receipts FROM PUBLIC,rastreia_runtime;
CREATE INDEX btg_pix_webhook_receipts_date ON btg_pix_webhook_receipts(received_at);
