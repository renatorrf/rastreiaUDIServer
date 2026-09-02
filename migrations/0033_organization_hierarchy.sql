SET LOCAL search_path TO rastreia, public;

CREATE TABLE companies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 name text NOT NULL CHECK(char_length(name) BETWEEN 2 AND 160), legal_name text NOT NULL,
 tax_id_encrypted text, status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tenant_id)
);
CREATE INDEX companies_tenant_idx ON companies(tenant_id,status);
ALTER TABLE stores ADD COLUMN company_id uuid;
-- Existing installations retain their organization without inventing a CNPJ.
INSERT INTO companies(tenant_id,name,legal_name)
 SELECT tenant.id,tenant.name,COALESCE(tenant.legal_name,tenant.name) FROM tenants tenant
 WHERE EXISTS(SELECT 1 FROM stores WHERE tenant_id=tenant.id);
UPDATE stores SET company_id=company.id FROM companies company WHERE company.tenant_id=stores.tenant_id;
ALTER TABLE stores ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE stores ADD CONSTRAINT stores_company_tenant_fk FOREIGN KEY(company_id,tenant_id) REFERENCES companies(id,tenant_id);
ALTER TABLE stores ADD CONSTRAINT stores_organization_key UNIQUE(id,tenant_id,company_id);
CREATE INDEX stores_company_idx ON stores(company_id,status);

CREATE TABLE user_access_scopes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 user_id uuid NOT NULL REFERENCES users(id), scope_level text NOT NULL CHECK(scope_level IN ('TENANT','COMPANY','STORE')),
 company_id uuid, store_id uuid, role text NOT NULL DEFAULT 'TENANT_MANAGER' CHECK(role='TENANT_MANAGER'),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED')),
 valid_from timestamptz NOT NULL DEFAULT now(), valid_until timestamptz,
 permissions jsonb NOT NULL DEFAULT '{}', created_by uuid REFERENCES platform_admins(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(valid_until IS NULL OR valid_until>valid_from),
 CHECK((scope_level='TENANT' AND company_id IS NULL AND store_id IS NULL)
    OR (scope_level='COMPANY' AND company_id IS NOT NULL AND store_id IS NULL)
    OR (scope_level='STORE' AND company_id IS NOT NULL AND store_id IS NOT NULL)),
 FOREIGN KEY(company_id,tenant_id) REFERENCES companies(id,tenant_id),
 FOREIGN KEY(store_id,tenant_id,company_id) REFERENCES stores(id,tenant_id,company_id)
);
CREATE UNIQUE INDEX access_scopes_tenant_unique ON user_access_scopes(user_id,tenant_id) WHERE scope_level='TENANT' AND status='ACTIVE';
CREATE UNIQUE INDEX access_scopes_company_unique ON user_access_scopes(user_id,company_id) WHERE scope_level='COMPANY' AND status='ACTIVE';
CREATE UNIQUE INDEX access_scopes_store_unique ON user_access_scopes(user_id,store_id) WHERE scope_level='STORE' AND status='ACTIVE';
CREATE INDEX access_scopes_lookup ON user_access_scopes(user_id,tenant_id,status);
-- Move explicit manager unit grants without broadening them. Operators retain
-- user_store_access. A single source makes revocation effective everywhere.
INSERT INTO user_access_scopes(tenant_id,user_id,scope_level,company_id,store_id,created_at)
 SELECT access.tenant_id,member.user_id,'STORE',store.company_id,store.id,access.created_at
 FROM user_store_access access JOIN tenant_users member ON member.id=access.tenant_user_id
 JOIN stores store ON store.id=access.store_id WHERE member.role='TENANT_MANAGER';
DELETE FROM user_store_access access USING tenant_users member
 WHERE member.id=access.tenant_user_id AND member.role='TENANT_MANAGER';

CREATE OR REPLACE FUNCTION rastreia.has_store_access(requested_user uuid,requested_store uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM stores store JOIN companies company ON company.id=store.company_id AND company.tenant_id=store.tenant_id
 JOIN tenants tenant ON tenant.id=store.tenant_id
 JOIN tenant_users member ON member.tenant_id=tenant.id AND member.user_id=requested_user
 JOIN users account ON account.id=member.user_id
 WHERE store.id=requested_store AND store.status='ACTIVE' AND company.status='ACTIVE' AND tenant.status='ACTIVE'
 AND member.status='ACTIVE' AND account.status='ACTIVE' AND account.email_verified_at IS NOT NULL
 AND (EXISTS(SELECT 1 FROM user_store_access access WHERE access.tenant_user_id=member.id AND access.store_id=store.id)
 OR (member.role='TENANT_MANAGER' AND EXISTS(SELECT 1 FROM user_access_scopes scope
   WHERE scope.user_id=requested_user AND scope.tenant_id=tenant.id AND scope.status='ACTIVE'
   AND scope.valid_from<=now() AND (scope.valid_until IS NULL OR scope.valid_until>now())
   AND (scope.scope_level='TENANT' OR (scope.scope_level='COMPANY' AND scope.company_id=company.id)
      OR (scope.scope_level='STORE' AND scope.store_id=store.id))))
 OR (member.role='COURIER' AND EXISTS(SELECT 1 FROM courier_store_links link JOIN courier_profiles profile ON profile.id=link.courier_profile_id
   WHERE link.store_id=store.id AND link.status='ACTIVE' AND profile.status='ACTIVE' AND profile.user_id=requested_user))))
$$;
REVOKE ALL ON FUNCTION rastreia.has_store_access(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.has_store_access(uuid,uuid) TO rastreia_runtime;

CREATE OR REPLACE FUNCTION rastreia.identity_units(requested_user uuid)
RETURNS TABLE(id uuid,name text,tenant_id uuid,tenant_slug citext,tenant_name text,role tenant_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT store.id,store.name,tenant.id,tenant.slug,tenant.name,member.role
 FROM stores store JOIN tenants tenant ON tenant.id=store.tenant_id
 JOIN tenant_users member ON member.tenant_id=tenant.id AND member.user_id=requested_user
 WHERE requested_user=current_user_id() AND has_store_access(requested_user,store.id)
 ORDER BY tenant.name,store.name
$$;

CREATE FUNCTION rastreia.organization_units(requested_user uuid)
RETURNS TABLE(id uuid,name text,tenant_id uuid,tenant_name text,company_id uuid,company_name text,role tenant_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT store.id,store.name,tenant.id,tenant.name,company.id,company.name,member.role
 FROM stores store JOIN companies company ON company.id=store.company_id JOIN tenants tenant ON tenant.id=store.tenant_id
 JOIN tenant_users member ON member.tenant_id=tenant.id AND member.user_id=requested_user
 WHERE requested_user=current_user_id() AND has_store_access(requested_user,store.id)
 ORDER BY tenant.name,company.name,store.name
$$;
REVOKE ALL ON FUNCTION rastreia.organization_units(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.organization_units(uuid) TO rastreia_runtime;

CREATE OR REPLACE FUNCTION rastreia.store_in_scope(requested_store uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT is_master() OR EXISTS(SELECT 1 FROM stores store JOIN companies company ON company.id=store.company_id
 JOIN tenants tenant ON tenant.id=store.tenant_id
 WHERE store.id=requested_store AND store.status='ACTIVE' AND company.status='ACTIVE' AND tenant.status='ACTIVE'
 AND (EXISTS(SELECT 1 FROM tracking_tokens token JOIN deliveries delivery ON delivery.id=token.delivery_id
   WHERE token.token_hash=NULLIF(current_setting('app.tracking_hash',true),'') AND token.revoked_at IS NULL
   AND token.expires_at>now() AND delivery.store_id=store.id)
 OR (has_store_access(current_user_id(),store.id)
   AND (NULLIF(current_setting('app.store_ids',true),'') IS NULL
     OR COALESCE(current_setting('app.store_ids',true),'[]')::jsonb ? store.id::text))))
$$;

CREATE OR REPLACE FUNCTION rastreia.tenant_session_is_current(requested_tenant_id uuid,requested_user_id uuid,
 requested_role text,requested_store_ids uuid[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM tenant_users member WHERE member.tenant_id=requested_tenant_id
 AND member.user_id=requested_user_id AND member.role::text=requested_role AND member.status='ACTIVE'
 AND COALESCE(array_length(requested_store_ids,1),0)>0
 AND NOT EXISTS(SELECT 1 FROM unnest(requested_store_ids) claimed(id)
  WHERE NOT EXISTS(SELECT 1 FROM stores store WHERE store.id=claimed.id AND store.tenant_id=requested_tenant_id
   AND has_store_access(requested_user_id,store.id))))
$$;

CREATE OR REPLACE FUNCTION rastreia.can_read_unit_billing(requested_store uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT is_master() OR EXISTS(SELECT 1 FROM tenant_users member JOIN stores store ON store.tenant_id=member.tenant_id
 WHERE store.id=requested_store AND member.user_id=current_user_id() AND member.role='TENANT_MANAGER'
 AND member.tenant_id=current_tenant_id() AND store_in_scope(store.id))
$$;

CREATE OR REPLACE FUNCTION rastreia.unit_accepts_new_operations(requested_store uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM stores store JOIN tenants tenant ON tenant.id=store.tenant_id
 JOIN companies company ON company.id=store.company_id AND company.tenant_id=tenant.id
 WHERE store.id=requested_store AND store.status='ACTIVE' AND tenant.status='ACTIVE' AND company.status='ACTIVE')
 AND NOT EXISTS(SELECT 1 FROM unit_financial_holds WHERE store_id=requested_store AND blocked_at IS NOT NULL
 AND released_at IS NULL AND (waiver_until IS NULL OR waiver_until<=now()))
$$;

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
CREATE POLICY companies_master ON companies USING(is_master()) WITH CHECK(is_master());
CREATE POLICY companies_scoped_read ON companies FOR SELECT USING(EXISTS(
 SELECT 1 FROM stores WHERE company_id=companies.id AND store_in_scope(id)));
ALTER TABLE user_access_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_access_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY scopes_master ON user_access_scopes USING(is_master()) WITH CHECK(is_master());
CREATE POLICY scopes_self_read ON user_access_scopes FOR SELECT USING(user_id=current_user_id());
GRANT SELECT,INSERT,UPDATE ON companies,user_access_scopes TO rastreia_runtime;
CREATE TRIGGER companies_master_only BEFORE INSERT OR UPDATE ON companies FOR EACH ROW EXECUTE PROCEDURE guard_master_unit_write();
CREATE TRIGGER companies_touch BEFORE UPDATE ON companies FOR EACH ROW EXECUTE PROCEDURE touch_updated_at();
CREATE TRIGGER scopes_touch BEFORE UPDATE ON user_access_scopes FOR EACH ROW EXECUTE PROCEDURE touch_updated_at();

CREATE OR REPLACE FUNCTION rastreia.derive_operation_company() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_company uuid;
BEGIN
 SELECT company_id INTO expected_company FROM stores WHERE id=NEW.store_id AND tenant_id=NEW.tenant_id;
 IF expected_company IS NULL OR (NEW.company_id IS NOT NULL AND NEW.company_id<>expected_company) THEN
  RAISE EXCEPTION 'ORGANIZATION_MISMATCH' USING ERRCODE='23514';
 END IF;
 NEW.company_id:=expected_company;
 RETURN NEW;
END $$;

-- Administrative observation is read-only; Master never receives an operational token.
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['deliveries','routes','shift_slots','shift_positions','incidents','courier_last_locations'] LOOP
  EXECUTE format('CREATE POLICY organization_master_read ON %I FOR SELECT USING(is_master())',table_name);
 END LOOP;
END $$;
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['deliveries','routes','shift_templates','shift_slots','delivery_offers','incidents'] LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN company_id uuid',table_name);
  EXECUTE format('UPDATE %I operation SET company_id=store.company_id FROM stores store WHERE store.id=operation.store_id AND store.tenant_id=operation.tenant_id',table_name);
  EXECUTE format('ALTER TABLE %I ALTER COLUMN company_id SET NOT NULL',table_name);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(store_id,tenant_id,company_id) REFERENCES stores(id,tenant_id,company_id)',table_name,table_name||'_organization_fk');
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE PROCEDURE derive_operation_company()',table_name||'_derive_company',table_name);
  EXECUTE format('CREATE INDEX %I ON %I(tenant_id,company_id,store_id)',table_name||'_organization_idx',table_name);
 END LOOP;
END $$;
