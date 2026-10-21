SET LOCAL search_path TO rastreia, public;

-- Commercial access is narrower than operational access (couriers/tracking).
CREATE FUNCTION rastreia.commerce_manage_store(requested_store uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM stores s JOIN tenant_users member ON member.tenant_id=s.tenant_id
 JOIN users account ON account.id=member.user_id
 WHERE s.id=requested_store AND s.tenant_id=current_tenant_id()
 AND member.user_id=current_user_id() AND member.role='TENANT_MANAGER' AND member.status='ACTIVE'
 AND account.status='ACTIVE' AND has_store_access(account.id,s.id))
$$;
REVOKE ALL ON FUNCTION rastreia.commerce_manage_store(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.commerce_manage_store(uuid) TO rastreia_runtime;

CREATE TABLE commerce_categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 name text NOT NULL CHECK(char_length(name) BETWEEN 2 AND 100),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tenant_id,store_id), FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id)
);
CREATE UNIQUE INDEX commerce_categories_name ON commerce_categories(store_id,lower(name));
CREATE TABLE commerce_products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 category_id uuid, name text NOT NULL CHECK(char_length(name) BETWEEN 2 AND 160),
 sku text NOT NULL CHECK(char_length(sku) BETWEEN 1 AND 80),
 description text NOT NULL DEFAULT '' CHECK(char_length(description)<=2000),
 price_cents integer NOT NULL CHECK(price_cents BETWEEN 0 AND 100000000),
 cost_cents integer NOT NULL CHECK(cost_cents BETWEEN 0 AND 100000000),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tenant_id,store_id), FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id),
 FOREIGN KEY(category_id,tenant_id,store_id) REFERENCES commerce_categories(id,tenant_id,store_id)
);
CREATE UNIQUE INDEX commerce_products_sku ON commerce_products(store_id,lower(sku));
CREATE INDEX commerce_products_list ON commerce_products(store_id,active,name,id);

CREATE TABLE live_plan_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL CHECK(code ~ '^[A-Z0-9_-]{2,40}$'),
 version integer NOT NULL CHECK(version>0), name text NOT NULL CHECK(char_length(name) BETWEEN 2 AND 120),
 monthly_price_cents integer NOT NULL CHECK(monthly_price_cents BETWEEN 0 AND 100000000),
 monthly_live_limit integer NOT NULL CHECK(monthly_live_limit BETWEEN 1 AND 1000),
 max_duration_minutes integer NOT NULL CHECK(max_duration_minutes BETWEEN 1 AND 120),
 max_concurrent_viewers integer NOT NULL CHECK(max_concurrent_viewers BETWEEN 1 AND 200),
 available boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by uuid NOT NULL REFERENCES platform_admins(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(code,version)
);
CREATE TABLE store_live_subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 plan_version_id uuid NOT NULL REFERENCES live_plan_versions(id),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CANCELLED')),
 reason text NOT NULL CHECK(char_length(reason) BETWEEN 5 AND 500),
 created_by uuid NOT NULL REFERENCES platform_admins(id), created_at timestamptz NOT NULL DEFAULT now(),
 cancelled_at timestamptz, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id)
);
CREATE INDEX store_live_subscriptions_period ON store_live_subscriptions(store_id,starts_at,ends_at);

ALTER TABLE commerce_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_categories_manager ON commerce_categories
 USING(tenant_id=current_tenant_id() AND commerce_manage_store(store_id))
 WITH CHECK(tenant_id=current_tenant_id() AND commerce_manage_store(store_id));
ALTER TABLE commerce_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_products FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_products_manager ON commerce_products
 USING(tenant_id=current_tenant_id() AND commerce_manage_store(store_id))
 WITH CHECK(tenant_id=current_tenant_id() AND commerce_manage_store(store_id));
ALTER TABLE store_live_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_live_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY live_subscriptions_master ON store_live_subscriptions USING(is_master()) WITH CHECK(is_master());
CREATE POLICY live_subscriptions_manager_read ON store_live_subscriptions FOR SELECT
 USING(tenant_id=current_tenant_id() AND commerce_manage_store(store_id));
ALTER TABLE live_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_plan_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY live_plans_master ON live_plan_versions USING(is_master()) WITH CHECK(is_master());
CREATE POLICY live_plans_subscribed_read ON live_plan_versions FOR SELECT USING(EXISTS(
 SELECT 1 FROM store_live_subscriptions s WHERE s.plan_version_id=live_plan_versions.id
 AND s.tenant_id=current_tenant_id() AND commerce_manage_store(s.store_id)));

GRANT SELECT,INSERT,UPDATE ON commerce_categories,commerce_products TO rastreia_runtime;
GRANT SELECT,INSERT ON live_plan_versions,store_live_subscriptions TO rastreia_runtime;
-- Contract terms are immutable: publishing a change creates a new version.
GRANT UPDATE(available,revision) ON live_plan_versions TO rastreia_runtime;
GRANT UPDATE(status,cancelled_at,version) ON store_live_subscriptions TO rastreia_runtime;
-- No seeds, entitlements, invoices or provider calls are created by this migration.
