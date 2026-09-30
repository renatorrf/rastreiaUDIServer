SET LOCAL search_path TO rastreia, public;

CREATE TABLE company_service_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('WEB_PUSH','WHATSAPP','SMS','IFOOD')),
  enabled boolean NOT NULL DEFAULT false,
  public_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_config_encrypted text,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, provider),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (company_id, tenant_id) REFERENCES companies(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX company_service_settings_tenant_company_idx
  ON company_service_settings (tenant_id, company_id, provider);

CREATE TRIGGER company_service_settings_touch_updated_at BEFORE UPDATE ON company_service_settings
FOR EACH ROW EXECUTE PROCEDURE rastreia.touch_updated_at();

ALTER TABLE company_service_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_service_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY company_service_settings_scope ON company_service_settings
USING (
  current_user <> 'rastreia_runtime'
  OR (
  tenant_id = current_tenant_id()
  AND EXISTS (
    SELECT 1 FROM tenant_users membership
    WHERE membership.tenant_id = company_service_settings.tenant_id
      AND membership.user_id = current_user_id()
      AND membership.status = 'ACTIVE'
      AND membership.role IN ('TENANT_MANAGER','STORE_OPERATOR')
  )
  AND EXISTS (
    SELECT 1 FROM stores store
    WHERE store.company_id = company_service_settings.company_id
      AND store.tenant_id = company_service_settings.tenant_id
      AND store_in_scope(store.id)
  ))
)
WITH CHECK (
  current_user <> 'rastreia_runtime'
  OR (
  tenant_id = current_tenant_id()
  AND EXISTS (
    SELECT 1 FROM tenant_users membership
    WHERE membership.tenant_id = company_service_settings.tenant_id
      AND membership.user_id = current_user_id()
      AND membership.status = 'ACTIVE'
      AND membership.role = 'TENANT_MANAGER'
  )
  AND EXISTS (
    SELECT 1 FROM stores store
    WHERE store.company_id = company_service_settings.company_id
      AND store.tenant_id = company_service_settings.tenant_id
      AND store_in_scope(store.id)
  ))
);

GRANT SELECT, INSERT, UPDATE ON company_service_settings TO rastreia_runtime;
