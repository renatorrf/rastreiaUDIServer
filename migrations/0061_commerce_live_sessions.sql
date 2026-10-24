SET LOCAL search_path TO rastreia, public;

ALTER TABLE store_live_subscriptions ADD CONSTRAINT store_live_subscriptions_scope UNIQUE(id,tenant_id,store_id);
CREATE TABLE commerce_live_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 public_token text NOT NULL UNIQUE CHECK(public_token ~ '^[a-f0-9]{64}$'),
 title text NOT NULL CHECK(char_length(title) BETWEEN 2 AND 160), scheduled_at timestamptz,
 status text NOT NULL DEFAULT 'WAITING' CHECK(status IN ('WAITING','LIVE','ENDED')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), current_product_id uuid,
 subscription_id uuid,
 started_at timestamptz, deadline_at timestamptz, ended_at timestamptz, end_reason text,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tenant_id,store_id), FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id),
 FOREIGN KEY(current_product_id,tenant_id,store_id) REFERENCES commerce_products(id,tenant_id,store_id),
 FOREIGN KEY(subscription_id,tenant_id,store_id) REFERENCES store_live_subscriptions(id,tenant_id,store_id),
 CHECK(status<>'LIVE' OR (started_at IS NOT NULL AND deadline_at IS NOT NULL AND subscription_id IS NOT NULL)),
 CHECK(deadline_at IS NULL OR deadline_at>started_at), CHECK(status<>'ENDED' OR ended_at IS NOT NULL)
);
CREATE INDEX commerce_live_sessions_list ON commerce_live_sessions(store_id,created_at DESC,id);
CREATE INDEX commerce_live_sessions_usage ON commerce_live_sessions(store_id,started_at) WHERE started_at IS NOT NULL;
CREATE UNIQUE INDEX commerce_live_sessions_one_running ON commerce_live_sessions(store_id) WHERE status='LIVE';
CREATE TABLE commerce_live_items (
 live_id uuid NOT NULL, tenant_id uuid NOT NULL, store_id uuid NOT NULL, product_id uuid NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 0 AND 99),
 PRIMARY KEY(live_id,product_id), UNIQUE(live_id,position),
 FOREIGN KEY(live_id,tenant_id,store_id) REFERENCES commerce_live_sessions(id,tenant_id,store_id),
 FOREIGN KEY(product_id,tenant_id,store_id) REFERENCES commerce_products(id,tenant_id,store_id)
);
ALTER TABLE commerce_live_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_live_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_live_sessions_manager ON commerce_live_sessions
 USING(tenant_id=current_tenant_id() AND commerce_manage_store(store_id))
 WITH CHECK(tenant_id=current_tenant_id() AND commerce_manage_store(store_id));
ALTER TABLE commerce_live_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_live_items FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_live_items_manager ON commerce_live_items
 USING(tenant_id=current_tenant_id() AND commerce_manage_store(store_id))
 WITH CHECK(tenant_id=current_tenant_id() AND commerce_manage_store(store_id));
GRANT SELECT,INSERT,UPDATE ON commerce_live_sessions TO rastreia_runtime;
GRANT SELECT,INSERT,DELETE ON commerce_live_items TO rastreia_runtime;

-- Managers may lock their current contract for a start, never edit its terms.
-- FOR SHARE directly on subscriptions would also require the master-only UPDATE policy.
CREATE FUNCTION commerce_lock_live_subscription(requested_store uuid,requested_subscription uuid)
RETURNS TABLE(id uuid,ends_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
BEGIN
 IF NOT commerce_manage_store(requested_store) THEN RETURN; END IF;
 RETURN QUERY SELECT s.id,s.ends_at FROM store_live_subscriptions s
 WHERE s.id=requested_subscription AND s.store_id=requested_store AND s.tenant_id=current_tenant_id()
 AND s.status='ACTIVE' AND s.starts_at<=now() AND s.ends_at>now() FOR SHARE;
END $$;
REVOKE ALL ON FUNCTION commerce_lock_live_subscription(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_lock_live_subscription(uuid,uuid) TO rastreia_runtime;

-- Internal public projection. No cost, stock count, tenant, token or administrative data.
CREATE FUNCTION commerce_live_public_product(requested_store uuid,requested_product uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'stockMode',p.stock_mode,
 'acceptsNotes',p.accepts_notes,'categoryId',p.category_id,'categoryName',c.name,
 'images',coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'alt',i.alt) ORDER BY i.position,i.id)
 FROM commerce_product_images i WHERE i.product_id=p.id AND NOT i.archived),'[]'::jsonb),
 'variants',(SELECT jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,
 'attributes',jsonb_build_object('color',coalesce(v.attributes->>'color',''),'size',coalesce(v.attributes->>'size','')),
 'priceCents',v.price_cents,'available',(p.stock_mode='MADE_TO_ORDER' OR b.on_hand>b.reserved)) ORDER BY v.is_default DESC,v.name,v.id)
 FROM commerce_variants v JOIN commerce_inventory_balances b ON b.variant_id=v.id WHERE v.product_id=p.id AND v.active))
 FROM commerce_products p LEFT JOIN commerce_categories c ON c.id=p.category_id
 JOIN commerce_storefronts f ON f.store_id=p.store_id AND f.tenant_id=p.tenant_id
 WHERE p.store_id=requested_store AND p.id=requested_product AND p.active AND p.published
 AND (c.id IS NULL OR c.active) AND commerce_public_store(f.slug) IS NOT NULL
 AND EXISTS(SELECT 1 FROM commerce_variants v JOIN commerce_inventory_balances b ON b.variant_id=v.id WHERE v.product_id=p.id AND v.active)
$$;
REVOKE ALL ON FUNCTION commerce_live_public_product(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION commerce_public_live(requested_token text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 WITH session AS (
 SELECT l.*,f.slug,f.title AS store_title,
 (l.status='LIVE' AND (l.deadline_at<=now() OR NOT EXISTS(SELECT 1 FROM store_live_subscriptions s
 WHERE s.id=l.subscription_id AND s.store_id=l.store_id AND s.tenant_id=l.tenant_id AND s.status='ACTIVE' AND s.starts_at<=now() AND s.ends_at>now()))) AS expired
 FROM commerce_live_sessions l JOIN commerce_storefronts f ON f.store_id=l.store_id AND f.tenant_id=l.tenant_id
 WHERE l.public_token=requested_token AND commerce_public_store(f.slug) IS NOT NULL
 ) SELECT jsonb_build_object('id',l.id,'sequence',l.version+CASE WHEN expired THEN 1 ELSE 0 END,
 'store',jsonb_build_object('slug',slug,'title',store_title),'title',l.title,
 'status',CASE WHEN expired THEN 'ENDED' ELSE l.status END,
 'featuredProduct',CASE WHEN l.status='LIVE' AND NOT expired AND EXISTS(SELECT 1 FROM commerce_live_items i WHERE i.live_id=l.id AND i.product_id=l.current_product_id)
 THEN commerce_live_public_product(l.store_id,l.current_product_id) ELSE NULL END) FROM session l
$$;
REVOKE ALL ON FUNCTION commerce_public_live(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_public_live(text) TO rastreia_runtime;
-- No sessions, subscriptions, charges or provider calls are created by this migration.
