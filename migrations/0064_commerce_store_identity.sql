-- Store identity; existing storefront tenant/unit RLS remains in force.
ALTER TABLE commerce_storefronts ADD COLUMN logo_key text, ADD COLUMN logo_version integer NOT NULL DEFAULT 0 CHECK (logo_version>=0);
GRANT UPDATE(logo_key,logo_version) ON commerce_storefronts TO rastreia_runtime;

CREATE OR REPLACE FUNCTION commerce_public_store(requested_slug text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT jsonb_build_object('slug',f.slug,'title',f.title,'description',f.description,'logoVersion',CASE WHEN f.logo_key IS NULL THEN 0 ELSE f.logo_version END,'categories',coalesce((SELECT jsonb_agg(jsonb_build_object('id',category.id,'name',category.name) ORDER BY category.name,category.id)
  FROM commerce_categories category WHERE category.store_id=f.store_id AND category.active AND EXISTS(SELECT 1 FROM commerce_products p WHERE p.category_id=category.id AND p.active AND p.published AND EXISTS(SELECT 1 FROM commerce_variants v WHERE v.product_id=p.id AND v.active))),'[]'::jsonb))
 FROM commerce_storefronts f JOIN stores s ON s.id=f.store_id AND s.tenant_id=f.tenant_id
 JOIN companies c ON c.id=s.company_id AND c.tenant_id=s.tenant_id JOIN tenants t ON t.id=s.tenant_id
 WHERE f.slug=requested_slug AND f.published AND s.status='ACTIVE' AND c.status='ACTIVE' AND t.status='ACTIVE'
$$;

CREATE FUNCTION commerce_public_logo(requested_slug text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT logo_key FROM commerce_storefronts WHERE slug=requested_slug AND commerce_public_store(requested_slug) IS NOT NULL
$$;
REVOKE ALL ON FUNCTION commerce_public_logo(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_public_logo(text) TO rastreia_runtime;

CREATE OR REPLACE FUNCTION commerce_public_live(requested_token text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 WITH session AS (
 SELECT l.*,f.slug,f.title AS store_title,
 (l.status='LIVE' AND (l.deadline_at<=now() OR NOT EXISTS(SELECT 1 FROM store_live_subscriptions s
 WHERE s.id=l.subscription_id AND s.store_id=l.store_id AND s.tenant_id=l.tenant_id AND s.status='ACTIVE' AND s.starts_at<=now() AND s.ends_at>now()))) AS expired
 FROM commerce_live_sessions l JOIN commerce_storefronts f ON f.store_id=l.store_id AND f.tenant_id=l.tenant_id
 WHERE l.public_token=requested_token AND commerce_public_store(f.slug) IS NOT NULL
 ) SELECT jsonb_build_object('id',l.id,'sequence',l.version+CASE WHEN expired THEN 1 ELSE 0 END,
 'store',jsonb_build_object('slug',slug,'title',store_title,'logoVersion',commerce_public_store(slug)->'logoVersion'),'title',l.title,
 'status',CASE WHEN expired THEN 'ENDED' ELSE l.status END,
 'featuredProduct',CASE WHEN l.status='LIVE' AND NOT expired AND EXISTS(SELECT 1 FROM commerce_live_items i WHERE i.live_id=l.id AND i.product_id=l.current_product_id)
 THEN commerce_live_public_product(l.store_id,l.current_product_id) ELSE NULL END) FROM session l
$$;
REVOKE ALL ON FUNCTION commerce_public_live(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_public_live(text) TO rastreia_runtime;


