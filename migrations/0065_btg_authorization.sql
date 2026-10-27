SET LOCAL search_path TO rastreia, public;

-- One short-lived authorization per company/environment, shared across Cloud Run replicas.
CREATE TABLE btg_authorization_sessions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  company_id uuid NOT NULL,
  mode text NOT NULL CHECK(mode IN ('sandbox','production')),
  user_id uuid NOT NULL REFERENCES users(id),
  state_hash text NOT NULL,
  browser_hash text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY(company_id,mode),
  FOREIGN KEY(company_id,tenant_id) REFERENCES companies(id,tenant_id)
);
CREATE TABLE btg_authorizations (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  company_id uuid NOT NULL,
  mode text NOT NULL CHECK(mode IN ('sandbox','production')),
  status text NOT NULL DEFAULT 'PENDING_ACCOUNT_VALIDATION' CHECK(status='PENDING_ACCOUNT_VALIDATION'),
  tokens_encrypted text NOT NULL,
  expires_at timestamptz NOT NULL,
  authorized_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,mode),
  FOREIGN KEY(company_id,tenant_id) REFERENCES companies(id,tenant_id)
);

ALTER TABLE btg_authorization_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE btg_authorization_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE btg_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE btg_authorizations FORCE ROW LEVEL SECURITY;

CREATE FUNCTION btg_company_in_scope(requested_tenant uuid,requested_company uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=rastreia,public,pg_temp AS $$
 SELECT requested_tenant=current_tenant_id()
 AND EXISTS(SELECT 1 FROM tenants t WHERE t.id=requested_tenant AND t.status='ACTIVE')
 AND EXISTS(SELECT 1 FROM tenant_users m JOIN users u ON u.id=m.user_id
 WHERE m.tenant_id=requested_tenant AND m.user_id=current_user_id()
 AND m.status='ACTIVE' AND m.role='TENANT_MANAGER' AND u.status='ACTIVE')
 AND EXISTS(SELECT 1 FROM companies c JOIN stores s ON s.company_id=c.id AND s.tenant_id=c.tenant_id
 WHERE c.id=requested_company AND c.tenant_id=requested_tenant AND c.status='ACTIVE' AND store_in_scope(s.id))
$$;
REVOKE ALL ON FUNCTION btg_company_in_scope(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION btg_company_in_scope(uuid,uuid) TO rastreia_runtime;
CREATE POLICY btg_sessions_scope ON btg_authorization_sessions
 USING(btg_company_in_scope(tenant_id,company_id))
 WITH CHECK(btg_company_in_scope(tenant_id,company_id));
CREATE POLICY btg_authorizations_scope ON btg_authorizations
 USING(btg_company_in_scope(tenant_id,company_id)) WITH CHECK(btg_company_in_scope(tenant_id,company_id));
GRANT SELECT,INSERT,UPDATE ON btg_authorization_sessions,btg_authorizations TO rastreia_runtime;
