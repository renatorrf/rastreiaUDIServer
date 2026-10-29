SET LOCAL search_path=rastreia,public;

-- Immutable application revisions. Binding is explicit; no existing credential is copied or removed.
CREATE TABLE btg_platform_applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 100),
 mode text NOT NULL CHECK(mode IN ('sandbox','production')),
 client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 200),
 secrets_encrypted text NOT NULL,
 webhook_id uuid UNIQUE,
 created_by uuid NOT NULL REFERENCES platform_admins(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE btg_platform_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE btg_platform_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY btg_apps_master_read ON btg_platform_applications FOR SELECT USING(current_user<>'rastreia_runtime' OR is_master());
CREATE POLICY btg_apps_master_insert ON btg_platform_applications FOR INSERT WITH CHECK(is_master());
CREATE POLICY btg_apps_connected_read ON btg_platform_applications FOR SELECT USING(EXISTS(
 SELECT 1 FROM company_service_settings s WHERE s.provider='BTG'
 AND s.public_config->>'platformApplicationId'=btg_platform_applications.id::text
 AND btg_company_in_scope(s.tenant_id,s.company_id)
));
GRANT SELECT,INSERT ON btg_platform_applications TO rastreia_runtime;

CREATE POLICY btg_settings_master ON company_service_settings
 USING(provider='BTG' AND is_master()) WITH CHECK(provider='BTG' AND is_master());
CREATE FUNCTION guard_btg_activation_write() RETURNS trigger LANGUAGE plpgsql
 SET search_path=rastreia,public,pg_temp AS $$
BEGIN
 IF (NEW.provider='BTG' OR (TG_OP='UPDATE' AND OLD.provider='BTG'))
 AND current_user='rastreia_runtime' AND NOT is_master() THEN
   RAISE EXCEPTION 'BTG configuration is managed by platform activation' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER company_btg_activation_guard BEFORE INSERT OR UPDATE ON company_service_settings
 FOR EACH ROW EXECUTE PROCEDURE guard_btg_activation_write();

-- Return only a boolean; never give activation staff access to raw payment data.
CREATE FUNCTION btg_activation_has_pending(requested_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT CASE WHEN is_master() THEN EXISTS(
  SELECT 1 FROM commerce_pix_payments WHERE company_id=requested_company
  AND (refund_required OR (paid_at IS NULL AND (status IN ('CREATED','REQUESTED','PENDING','REVIEW_REQUIRED')
       OR created_at>now()-interval '7 days')))
 ) ELSE true END
$$;
REVOKE ALL ON FUNCTION btg_activation_has_pending(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION btg_activation_has_pending(uuid) TO rastreia_runtime;

-- Read-only status for activation, no token or bank balances exposed.
CREATE FUNCTION btg_activation_authorization(requested_company uuid,requested_mode text,requested_version integer)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT CASE WHEN NOT is_master() THEN NULL
 WHEN EXISTS(SELECT 1 FROM btg_authorizations WHERE company_id=requested_company AND mode=requested_mode
 AND settings_version=requested_version) THEN 'PENDING_ACCOUNT_VALIDATION' ELSE 'AWAITING_AUTHORIZATION' END
$$;
REVOKE ALL ON FUNCTION btg_activation_authorization(uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION btg_activation_authorization(uuid,text,integer) TO rastreia_runtime;

-- Foundation only: bank identity must come from authenticated provider data in a later stage.
-- No account is created, trusted or marked validated by this migration.
CREATE TABLE company_bank_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,
 company_id uuid NOT NULL,provider text NOT NULL CHECK(provider IN ('BTG','MANUAL')),
 name text NOT NULL,provider_account_id text,identity_encrypted text NOT NULL,
 status text NOT NULL DEFAULT 'PENDING_VALIDATION' CHECK(status IN ('PENDING_VALIDATION','VALIDATED','DISABLED')),
 validated_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,tenant_id) REFERENCES companies(id,tenant_id),
 UNIQUE(company_id,provider,provider_account_id),
 CHECK((status='VALIDATED')=(validated_at IS NOT NULL))
);
ALTER TABLE company_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_bank_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY company_bank_accounts_read ON company_bank_accounts FOR SELECT
 USING(is_master() OR btg_company_in_scope(tenant_id,company_id));
GRANT SELECT ON company_bank_accounts TO rastreia_runtime;
