SET LOCAL search_path TO rastreia,public;
ALTER TABLE commerce_products ADD COLUMN addons jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(addons)='array' AND jsonb_array_length(addons)<=4 AND (addons='[]' OR stock_mode='MADE_TO_ORDER'));
ALTER TABLE commerce_variants ADD COLUMN addon_keys text[];
GRANT UPDATE(addons) ON commerce_products TO rastreia_runtime;

-- Each combination is a server-priced sellable SKU. Existing cart, live, stock,
-- order snapshots, Pix and accounting use the same variant and unit price.
CREATE FUNCTION commerce_sync_addons() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE mask integer; names text[]; surcharge integer; combination_sku text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.addons=OLD.addons AND NEW.price_cents=OLD.price_cents AND NEW.cost_cents=OLD.cost_cents THEN RETURN NEW; END IF;
 UPDATE commerce_variants SET active=false,version=version+1 WHERE product_id=NEW.id AND addon_keys IS NOT NULL AND active;
 FOR mask IN 1..((1<<jsonb_array_length(NEW.addons))-1) LOOP
   SELECT array_agg(a->>'name' ORDER BY lower(a->>'name')),sum((a->>'priceCents')::integer) INTO names,surcharge
   FROM jsonb_array_elements(NEW.addons) WITH ORDINALITY t(a,n) WHERE (mask & (1<<(n::integer-1)))<>0;
   combination_sku:='AD-'||md5(NEW.id::text||lower(to_json(names)::text));
   UPDATE commerce_variants SET active=true,addon_keys=names,name='Com '||array_to_string(names,' + '),price_cents=NEW.price_cents+surcharge,cost_cents=NEW.cost_cents,version=version+1,updated_at=now()
     WHERE product_id=NEW.id AND addon_keys IS NOT NULL AND sku=combination_sku;
   IF NOT FOUND THEN
     INSERT INTO commerce_variants(tenant_id,store_id,product_id,name,sku,price_cents,cost_cents,addon_keys)
     VALUES(NEW.tenant_id,NEW.store_id,NEW.id,'Com '||array_to_string(names,' + '),combination_sku,NEW.price_cents+surcharge,NEW.cost_cents,names);
   END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION commerce_sync_addons() FROM PUBLIC;
CREATE TRIGGER commerce_product_addons AFTER INSERT OR UPDATE OF addons,price_cents,cost_cents ON commerce_products FOR EACH ROW EXECUTE PROCEDURE commerce_sync_addons();
CREATE OR REPLACE FUNCTION commerce_public_products_without_images(requested_slug text,query_text text,requested_category uuid,page_limit integer,page_offset integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 WITH eligible AS (
  SELECT p.id,p.name,p.description,p.stock_mode,p.accepts_notes,p.addons,p.category_id,c.name AS category_name
  FROM commerce_products p JOIN commerce_storefronts f ON f.store_id=p.store_id AND f.tenant_id=p.tenant_id
  LEFT JOIN commerce_categories c ON c.id=p.category_id
  WHERE f.slug=requested_slug AND commerce_public_store(requested_slug) IS NOT NULL
   AND p.active AND p.published AND (c.id IS NULL OR c.active)
   AND (coalesce(query_text,'')='' OR position(lower(left(query_text,160)) in lower(p.name))>0)
   AND (requested_category IS NULL OR p.category_id=requested_category)
   AND EXISTS(SELECT 1 FROM commerce_variants v WHERE v.product_id=p.id AND v.active)
 ), page AS (SELECT * FROM eligible ORDER BY name,id LIMIT greatest(1,least(page_limit,50)) OFFSET greatest(0,least(page_offset,100000)))
 SELECT jsonb_build_object('total',(SELECT count(*) FROM eligible),'data',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'id',p.id,'stockMode',p.stock_mode,'acceptsNotes',p.accepts_notes,'addons',p.addons,'name',p.name,'description',p.description,'categoryId',p.category_id,'categoryName',p.category_name,
  'variants',(SELECT jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'addonKeys',v.addon_keys,'attributes',jsonb_build_object('color',coalesce(v.attributes->>'color',''),'size',coalesce(v.attributes->>'size','')),'priceCents',v.price_cents,'available',(p.stock_mode='MADE_TO_ORDER' OR b.on_hand>b.reserved)) ORDER BY v.is_default DESC,v.name,v.id)
   FROM commerce_variants v JOIN commerce_inventory_balances b ON b.variant_id=v.id WHERE v.product_id=p.id AND v.active)
 ) ORDER BY p.name,p.id) FROM page p),'[]'::jsonb))
$$;
CREATE OR REPLACE FUNCTION commerce_live_public_product(requested_store uuid,requested_product uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'stockMode',p.stock_mode,
 'acceptsNotes',p.accepts_notes,'addons',p.addons,'categoryId',p.category_id,'categoryName',c.name,
 'images',coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'alt',i.alt) ORDER BY i.position,i.id)
 FROM commerce_product_images i WHERE i.product_id=p.id AND NOT i.archived),'[]'::jsonb),
 'variants',(SELECT jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'addonKeys',v.addon_keys,
 'attributes',jsonb_build_object('color',coalesce(v.attributes->>'color',''),'size',coalesce(v.attributes->>'size','')),
 'priceCents',v.price_cents,'available',(p.stock_mode='MADE_TO_ORDER' OR b.on_hand>b.reserved)) ORDER BY v.is_default DESC,v.name,v.id)
 FROM commerce_variants v JOIN commerce_inventory_balances b ON b.variant_id=v.id WHERE v.product_id=p.id AND v.active))
 FROM commerce_products p LEFT JOIN commerce_categories c ON c.id=p.category_id
 JOIN commerce_storefronts f ON f.store_id=p.store_id AND f.tenant_id=p.tenant_id
 WHERE p.store_id=requested_store AND p.id=requested_product AND p.active AND p.published
 AND (c.id IS NULL OR c.active) AND commerce_public_store(f.slug) IS NOT NULL
 AND EXISTS(SELECT 1 FROM commerce_variants v JOIN commerce_inventory_balances b ON b.variant_id=v.id WHERE v.product_id=p.id AND v.active)
$$;
