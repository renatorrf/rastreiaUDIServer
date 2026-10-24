SET LOCAL search_path TO rastreia, public;
-- Existing products remain stock-controlled. Production is an explicit manager choice.
ALTER TABLE commerce_products ADD COLUMN stock_mode text NOT NULL DEFAULT 'STOCKED'
 CHECK(stock_mode IN ('STOCKED','MADE_TO_ORDER'));

-- Keep publication/category/tenant checks and the media wrapper from 0055.
CREATE OR REPLACE FUNCTION commerce_public_products_without_images(requested_slug text,query_text text,requested_category uuid,page_limit integer,page_offset integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 WITH eligible AS (
  SELECT p.id,p.name,p.description,p.stock_mode,p.category_id,c.name AS category_name
  FROM commerce_products p JOIN commerce_storefronts f ON f.store_id=p.store_id AND f.tenant_id=p.tenant_id
  LEFT JOIN commerce_categories c ON c.id=p.category_id
  WHERE f.slug=requested_slug AND commerce_public_store(requested_slug) IS NOT NULL
   AND p.active AND p.published AND (c.id IS NULL OR c.active)
   AND (coalesce(query_text,'')='' OR position(lower(left(query_text,160)) in lower(p.name))>0)
   AND (requested_category IS NULL OR p.category_id=requested_category)
   AND EXISTS(SELECT 1 FROM commerce_variants v WHERE v.product_id=p.id AND v.active)
 ), page AS (SELECT * FROM eligible ORDER BY name,id LIMIT greatest(1,least(page_limit,50)) OFFSET greatest(0,least(page_offset,100000)))
 SELECT jsonb_build_object('total',(SELECT count(*) FROM eligible),'data',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'id',p.id,'stockMode',p.stock_mode,'name',p.name,'description',p.description,'categoryId',p.category_id,'categoryName',p.category_name,
  'variants',(SELECT jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'attributes',jsonb_build_object('color',coalesce(v.attributes->>'color',''),'size',coalesce(v.attributes->>'size','')),'priceCents',v.price_cents,'available',(p.stock_mode='MADE_TO_ORDER' OR b.on_hand>b.reserved)) ORDER BY v.is_default DESC,v.name,v.id)
   FROM commerce_variants v JOIN commerce_inventory_balances b ON b.variant_id=v.id WHERE v.product_id=p.id AND v.active)
 ) ORDER BY p.name,p.id) FROM page p),'[]'::jsonb))
$$;

-- Cart quantities remain bounded to 99; production never changes physical balances.
CREATE OR REPLACE FUNCTION commerce_cart_read(requested_cart uuid,owner_hash text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 WITH cart AS (
 SELECT c.*,f.slug,f.title,commerce_public_store(f.slug) IS NOT NULL AS store_available
 FROM commerce_guest_carts c JOIN commerce_storefronts f ON f.store_id=c.store_id AND f.tenant_id=c.tenant_id
 WHERE c.id=requested_cart AND c.token_hash=owner_hash
 ), items AS (
 SELECT i.*,p.id AS product_id,
 (c.store_available AND p.active AND p.published AND v.active AND (category.id IS NULL OR category.active)) AS listed,
 v.price_cents,CASE WHEN p.stock_mode='MADE_TO_ORDER' THEN 99 ELSE b.on_hand-b.reserved END AS stock,
 CASE WHEN c.store_available AND p.active AND p.published AND v.active AND (category.id IS NULL OR category.active)
 THEN (SELECT img.id FROM commerce_product_images img WHERE img.product_id=p.id AND NOT img.archived ORDER BY img.position,img.id LIMIT 1) ELSE NULL END AS image_id
 FROM cart c JOIN commerce_cart_items i ON i.cart_id=c.id AND i.store_id=c.store_id AND i.tenant_id=c.tenant_id
 JOIN commerce_variants v ON v.id=i.variant_id AND v.store_id=i.store_id AND v.tenant_id=i.tenant_id
 JOIN commerce_products p ON p.id=v.product_id LEFT JOIN commerce_categories category ON category.id=p.category_id
 JOIN commerce_inventory_balances b ON b.variant_id=v.id
 ), projection AS (
 SELECT i.variant_id,i.quantity,i.product_name,i.variant_name,i.product_id,i.image_id,
 CASE WHEN i.listed THEN i.price_cents ELSE i.unit_price_cents END AS display_price,
 i.listed AND i.price_cents<>i.unit_price_cents AS price_changed,
 CASE WHEN NOT i.listed THEN 'UNAVAILABLE' WHEN i.stock<i.quantity THEN 'INSUFFICIENT_STOCK' ELSE 'AVAILABLE' END AS status,
 CASE WHEN i.listed THEN least(99,greatest(0,i.stock)) ELSE 0 END AS max_quantity
 FROM items i
 ) SELECT jsonb_build_object('id',c.id,'slug',c.slug,'storeTitle',c.title,'version',c.version,'expiresAt',c.expires_at,
 'expired',c.expires_at<=now(),'storeAvailable',c.store_available,'currency','BRL',
 'totalQuantity',coalesce((SELECT sum(p.quantity) FROM projection p),0),
 'subtotalCents',coalesce((SELECT sum(p.display_price::bigint*p.quantity) FROM projection p),0),
 'items',coalesce((SELECT jsonb_agg(jsonb_build_object('variantId',p.variant_id,'productId',p.product_id,'productName',p.product_name,
 'variantName',p.variant_name,'quantity',p.quantity,'unitPriceCents',p.display_price,'lineTotalCents',p.display_price::bigint*p.quantity,
 'priceChanged',p.price_changed,'status',p.status,'maxQuantity',p.max_quantity,'imageId',p.image_id) ORDER BY p.product_name,p.variant_name,p.variant_id) FROM projection p),'[]'::jsonb)) FROM cart c
$$;

CREATE OR REPLACE FUNCTION commerce_cart_change(requested_cart uuid,owner_hash text,requested_variant uuid,requested_quantity integer,expected_version integer,request_key text,payload_hash text,refresh_cart boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE cart commerce_guest_carts%ROWTYPE; previous_hash text; item record; item_count integer;
BEGIN
 IF expected_version IS NULL OR expected_version<1 OR request_key IS NULL OR char_length(request_key) NOT BETWEEN 8 AND 100
 OR payload_hash IS NULL OR payload_hash !~ '^[a-f0-9]{64}$' OR refresh_cart IS NULL
 OR (NOT refresh_cart AND (requested_variant IS NULL OR requested_quantity IS NULL OR requested_quantity NOT BETWEEN 0 AND 99))
 THEN RAISE EXCEPTION 'Invalid cart change' USING ERRCODE='22023'; END IF;
 SELECT * INTO cart FROM commerce_guest_carts WHERE id=requested_cart AND token_hash=owner_hash FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cart not found' USING ERRCODE='P0002'; END IF;
 SELECT m.request_hash INTO previous_hash FROM commerce_cart_mutations m WHERE m.cart_id=cart.id AND m.request_key=commerce_cart_change.request_key;
 IF FOUND THEN
  IF previous_hash<>payload_hash THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='23505'; END IF;
  RETURN commerce_cart_read(cart.id,owner_hash);
 END IF;
 IF cart.version<>expected_version THEN RAISE EXCEPTION 'Cart version conflict' USING ERRCODE='40001'; END IF;
 IF refresh_cart THEN
  -- Explicit review preserves unavailable lines and refreshes only currently public prices/names.
  UPDATE commerce_cart_items i SET unit_price_cents=v.price_cents,product_name=p.name,variant_name=v.name
  FROM commerce_variants v JOIN commerce_products p ON p.id=v.product_id LEFT JOIN commerce_categories category ON category.id=p.category_id
  WHERE i.cart_id=cart.id AND v.id=i.variant_id AND v.store_id=cart.store_id
  AND v.active AND p.active AND p.published AND (category.id IS NULL OR category.active)
  AND EXISTS(SELECT 1 FROM commerce_storefronts f WHERE f.store_id=cart.store_id AND commerce_public_store(f.slug) IS NOT NULL);
 ELSE
  IF requested_quantity=0 THEN
   DELETE FROM commerce_cart_items WHERE cart_id=cart.id AND variant_id=requested_variant;
  ELSE
   IF cart.expires_at<=now() THEN RAISE EXCEPTION 'Cart expired' USING ERRCODE='55000'; END IF;
   SELECT p.name AS product_name,v.name AS variant_name,v.price_cents,CASE WHEN p.stock_mode='MADE_TO_ORDER' THEN 99 ELSE b.on_hand-b.reserved END AS available INTO item
   FROM commerce_variants v JOIN commerce_products p ON p.id=v.product_id JOIN commerce_inventory_balances b ON b.variant_id=v.id
   JOIN commerce_storefronts f ON f.store_id=v.store_id AND f.tenant_id=v.tenant_id
   LEFT JOIN commerce_categories category ON category.id=p.category_id
   WHERE v.id=requested_variant AND v.store_id=cart.store_id AND v.tenant_id=cart.tenant_id
   AND v.active AND p.active AND p.published AND (category.id IS NULL OR category.active) AND commerce_public_store(f.slug) IS NOT NULL;
   IF NOT FOUND THEN RAISE EXCEPTION 'Item unavailable' USING ERRCODE='P0001'; END IF;
   IF item.available<requested_quantity THEN RAISE EXCEPTION 'Insufficient stock' USING ERRCODE='23514'; END IF;
   SELECT count(*) INTO item_count FROM commerce_cart_items WHERE cart_id=cart.id;
   IF item_count>=50 AND NOT EXISTS(SELECT 1 FROM commerce_cart_items WHERE cart_id=cart.id AND variant_id=requested_variant)
   THEN RAISE EXCEPTION 'Cart item limit' USING ERRCODE='54000'; END IF;
   INSERT INTO commerce_cart_items(cart_id,tenant_id,store_id,variant_id,quantity,product_name,variant_name,unit_price_cents)
   VALUES(cart.id,cart.tenant_id,cart.store_id,requested_variant,requested_quantity,item.product_name,item.variant_name,item.price_cents)
   ON CONFLICT(cart_id,variant_id) DO UPDATE SET quantity=EXCLUDED.quantity,product_name=EXCLUDED.product_name,variant_name=EXCLUDED.variant_name,unit_price_cents=EXCLUDED.unit_price_cents;
  END IF;
 END IF;
 UPDATE commerce_guest_carts SET version=version+1,updated_at=now(),expires_at=now()+interval '30 days' WHERE id=cart.id;
 INSERT INTO commerce_cart_mutations(cart_id,request_key,request_hash) VALUES(cart.id,request_key,payload_hash);
 RETURN commerce_cart_read(cart.id,owner_hash);
END $$;

REVOKE ALL ON FUNCTION commerce_public_products_without_images(text,text,uuid,integer,integer) FROM PUBLIC,rastreia_runtime;
REVOKE ALL ON FUNCTION commerce_cart_read(uuid,text),commerce_cart_change(uuid,text,uuid,integer,integer,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_cart_read(uuid,text),commerce_cart_change(uuid,text,uuid,integer,integer,text,text,boolean) TO rastreia_runtime;

