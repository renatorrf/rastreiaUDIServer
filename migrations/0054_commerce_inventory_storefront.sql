SET LOCAL search_path TO rastreia, public;

ALTER TABLE commerce_products ADD COLUMN published boolean NOT NULL DEFAULT false;
CREATE TABLE commerce_variants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 product_id uuid NOT NULL, name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 120),
 sku text NOT NULL CHECK(char_length(sku) BETWEEN 1 AND 80),
 attributes jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(attributes)='object' AND octet_length(attributes::text)<=2000),
 price_cents integer NOT NULL CHECK(price_cents BETWEEN 0 AND 100000000),
 cost_cents integer NOT NULL CHECK(cost_cents BETWEEN 0 AND 100000000),
 minimum_stock integer NOT NULL DEFAULT 0 CHECK(minimum_stock BETWEEN 0 AND 1000000),
 is_default boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tenant_id,store_id), FOREIGN KEY(product_id,tenant_id,store_id) REFERENCES commerce_products(id,tenant_id,store_id)
);
CREATE UNIQUE INDEX commerce_variants_sku ON commerce_variants(store_id,lower(sku));
CREATE UNIQUE INDEX commerce_variants_default ON commerce_variants(product_id) WHERE is_default;
CREATE UNIQUE INDEX commerce_variants_name ON commerce_variants(product_id,lower(name));
CREATE INDEX commerce_variants_product ON commerce_variants(product_id,active);
CREATE TABLE commerce_inventory_balances (
 variant_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 on_hand integer NOT NULL DEFAULT 0 CHECK(on_hand BETWEEN 0 AND 1000000),
 reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=on_hand),
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(variant_id,tenant_id,store_id) REFERENCES commerce_variants(id,tenant_id,store_id)
);
CREATE TABLE commerce_inventory_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, store_id uuid NOT NULL, variant_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('ENTRY','EXIT','LOSS','CONSUMPTION','RETURN','ADJUSTMENT')),
 delta integer NOT NULL CHECK(delta<>0), before_quantity integer NOT NULL, after_quantity integer NOT NULL CHECK(after_quantity>=0),
 reason text NOT NULL CHECK(char_length(reason) BETWEEN 5 AND 500), actor_user_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(after_quantity=before_quantity+delta),
 FOREIGN KEY(variant_id,tenant_id,store_id) REFERENCES commerce_variants(id,tenant_id,store_id)
);
CREATE INDEX commerce_inventory_history ON commerce_inventory_movements(store_id,variant_id,created_at DESC,id);
CREATE TABLE commerce_storefronts (
 store_id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
 slug text NOT NULL UNIQUE CHECK(slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
 title text NOT NULL CHECK(char_length(title) BETWEEN 2 AND 120),
 description text NOT NULL DEFAULT '' CHECK(char_length(description)<=1000),
 published boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id)
);

ALTER TABLE commerce_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_variants FORCE ROW LEVEL SECURITY;
CREATE POLICY variants_manager ON commerce_variants USING(tenant_id=current_tenant_id() AND commerce_manage_store(store_id)) WITH CHECK(tenant_id=current_tenant_id() AND commerce_manage_store(store_id));
ALTER TABLE commerce_inventory_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_inventory_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY balances_manager ON commerce_inventory_balances FOR SELECT USING(tenant_id=current_tenant_id() AND commerce_manage_store(store_id));
ALTER TABLE commerce_inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_inventory_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY movements_manager ON commerce_inventory_movements FOR SELECT USING(tenant_id=current_tenant_id() AND commerce_manage_store(store_id));
ALTER TABLE commerce_storefronts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_storefronts FORCE ROW LEVEL SECURITY;
CREATE POLICY storefront_manager ON commerce_storefronts USING(tenant_id=current_tenant_id() AND commerce_manage_store(store_id)) WITH CHECK(tenant_id=current_tenant_id() AND commerce_manage_store(store_id));
GRANT SELECT ON commerce_variants,commerce_inventory_balances,commerce_inventory_movements,commerce_storefronts TO rastreia_runtime;
GRANT INSERT ON commerce_variants,commerce_storefronts TO rastreia_runtime;
GRANT UPDATE(name,sku,attributes,price_cents,cost_cents,minimum_stock,active,version,updated_at) ON commerce_variants TO rastreia_runtime;
GRANT UPDATE(title,description,published,version,updated_at) ON commerce_storefronts TO rastreia_runtime;

CREATE FUNCTION commerce_initialize_balance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
BEGIN
 INSERT INTO commerce_inventory_balances(variant_id,tenant_id,store_id) VALUES(NEW.id,NEW.tenant_id,NEW.store_id);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION commerce_initialize_balance() FROM PUBLIC;
CREATE TRIGGER commerce_variant_balance AFTER INSERT ON commerce_variants FOR EACH ROW EXECUTE PROCEDURE commerce_initialize_balance();

CREATE FUNCTION commerce_default_variant() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO commerce_variants(tenant_id,store_id,product_id,name,sku,price_cents,cost_cents,is_default)
   VALUES(NEW.tenant_id,NEW.store_id,NEW.id,'Padrão',NEW.sku,NEW.price_cents,NEW.cost_cents,true);
 ELSE
  UPDATE commerce_variants SET sku=NEW.sku,price_cents=NEW.price_cents,cost_cents=NEW.cost_cents,version=version+1,updated_at=now()
   WHERE product_id=NEW.id AND is_default;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION commerce_default_variant() FROM PUBLIC;
CREATE TRIGGER commerce_product_variant AFTER INSERT OR UPDATE OF sku,price_cents,cost_cents ON commerce_products FOR EACH ROW EXECUTE PROCEDURE commerce_default_variant();
-- Existing products gain a zero balance; no guessed physical stock and no publication.
INSERT INTO commerce_variants(tenant_id,store_id,product_id,name,sku,price_cents,cost_cents,is_default)
 SELECT tenant_id,store_id,id,'Padrão',sku,price_cents,cost_cents,true FROM commerce_products;

CREATE FUNCTION commerce_adjust_inventory(requested_variant uuid,requested_store uuid,expected_version integer,quantity_delta integer,movement_kind text,movement_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE balance commerce_inventory_balances%ROWTYPE; movement_id uuid;
BEGIN
 IF NOT commerce_manage_store(requested_store) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 IF expected_version IS NULL OR expected_version<1 OR quantity_delta IS NULL OR movement_kind IS NULL OR movement_reason IS NULL
  OR quantity_delta=0 OR abs(quantity_delta::bigint)>1000000 OR char_length(trim(movement_reason)) NOT BETWEEN 5 AND 500
  OR movement_kind NOT IN ('ENTRY','EXIT','LOSS','CONSUMPTION','RETURN','ADJUSTMENT')
  OR (movement_kind IN ('ENTRY','RETURN') AND quantity_delta<0)
  OR (movement_kind IN ('EXIT','LOSS','CONSUMPTION') AND quantity_delta>0)
 THEN RAISE EXCEPTION 'Invalid movement' USING ERRCODE='22023'; END IF;
 SELECT * INTO balance FROM commerce_inventory_balances WHERE variant_id=requested_variant AND store_id=requested_store AND tenant_id=current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Variant not found' USING ERRCODE='P0002'; END IF;
 IF balance.version<>expected_version THEN RAISE EXCEPTION 'Stock version conflict' USING ERRCODE='40001'; END IF;
 IF balance.on_hand::bigint+quantity_delta<balance.reserved OR balance.on_hand::bigint+quantity_delta>1000000 THEN
  RAISE EXCEPTION 'Insufficient stock or stock limit exceeded' USING ERRCODE='23514';
 END IF;
 UPDATE commerce_inventory_balances SET on_hand=on_hand+quantity_delta,version=version+1,updated_at=now() WHERE variant_id=requested_variant;
 INSERT INTO commerce_inventory_movements(tenant_id,store_id,variant_id,kind,delta,before_quantity,after_quantity,reason,actor_user_id)
 VALUES(balance.tenant_id,balance.store_id,requested_variant,movement_kind,quantity_delta,balance.on_hand,balance.on_hand+quantity_delta,trim(movement_reason),current_user_id()) RETURNING id INTO movement_id;
 RETURN movement_id;
END $$;
REVOKE ALL ON FUNCTION commerce_adjust_inventory(uuid,uuid,integer,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_adjust_inventory(uuid,uuid,integer,integer,text,text) TO rastreia_runtime;

-- Public access is a bounded projection, not SELECT privileges/policies on private tables.
CREATE FUNCTION commerce_public_store(requested_slug text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT jsonb_build_object('slug',f.slug,'title',f.title,'description',f.description,'categories',coalesce((SELECT jsonb_agg(jsonb_build_object('id',category.id,'name',category.name) ORDER BY category.name,category.id)
  FROM commerce_categories category WHERE category.store_id=f.store_id AND category.active AND EXISTS(SELECT 1 FROM commerce_products p WHERE p.category_id=category.id AND p.active AND p.published AND EXISTS(SELECT 1 FROM commerce_variants v WHERE v.product_id=p.id AND v.active))),'[]'::jsonb))
 FROM commerce_storefronts f JOIN stores s ON s.id=f.store_id AND s.tenant_id=f.tenant_id
 JOIN companies c ON c.id=s.company_id AND c.tenant_id=s.tenant_id JOIN tenants t ON t.id=s.tenant_id
 WHERE f.slug=requested_slug AND f.published AND s.status='ACTIVE' AND c.status='ACTIVE' AND t.status='ACTIVE'
$$;
CREATE FUNCTION commerce_public_products(requested_slug text,query_text text,requested_category uuid,page_limit integer,page_offset integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 WITH eligible AS (
  SELECT p.id,p.name,p.description,p.category_id,c.name AS category_name
  FROM commerce_products p JOIN commerce_storefronts f ON f.store_id=p.store_id AND f.tenant_id=p.tenant_id
  LEFT JOIN commerce_categories c ON c.id=p.category_id
  WHERE f.slug=requested_slug AND commerce_public_store(requested_slug) IS NOT NULL
   AND p.active AND p.published AND (c.id IS NULL OR c.active)
   AND (coalesce(query_text,'')='' OR position(lower(left(query_text,160)) in lower(p.name))>0)
   AND (requested_category IS NULL OR p.category_id=requested_category)
   AND EXISTS(SELECT 1 FROM commerce_variants v WHERE v.product_id=p.id AND v.active)
 ), page AS (SELECT * FROM eligible ORDER BY name,id LIMIT greatest(1,least(page_limit,50)) OFFSET greatest(0,least(page_offset,100000)))
 SELECT jsonb_build_object('total',(SELECT count(*) FROM eligible),'data',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'id',p.id,'name',p.name,'description',p.description,'categoryId',p.category_id,'categoryName',p.category_name,
  'variants',(SELECT jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'attributes',jsonb_build_object('color',coalesce(v.attributes->>'color',''),'size',coalesce(v.attributes->>'size','')),'priceCents',v.price_cents,'available',b.on_hand>b.reserved) ORDER BY v.is_default DESC,v.name,v.id)
   FROM commerce_variants v JOIN commerce_inventory_balances b ON b.variant_id=v.id WHERE v.product_id=p.id AND v.active)
 ) ORDER BY p.name,p.id) FROM page p),'[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION commerce_public_store(text),commerce_public_products(text,text,uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_public_store(text),commerce_public_products(text,text,uuid,integer,integer) TO rastreia_runtime;
