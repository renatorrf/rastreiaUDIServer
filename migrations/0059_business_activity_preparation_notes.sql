SET LOCAL search_path TO rastreia, public;
ALTER TABLE companies ADD COLUMN business_activity text NOT NULL DEFAULT 'GENERAL'
 CHECK(business_activity IN ('GENERAL','FASHION','FOOTWEAR','FOOD'));
ALTER TABLE commerce_products ADD COLUMN accepts_notes boolean NOT NULL DEFAULT false;
ALTER TABLE commerce_cart_items ADD COLUMN preparation_notes text NOT NULL DEFAULT '' CHECK(char_length(preparation_notes)<=500);
GRANT UPDATE(business_activity) ON companies TO rastreia_runtime;
GRANT UPDATE(accepts_notes) ON commerce_products TO rastreia_runtime;

CREATE OR REPLACE FUNCTION commerce_public_products_without_images(requested_slug text,query_text text,requested_category uuid,page_limit integer,page_offset integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 WITH eligible AS (
  SELECT p.id,p.name,p.description,p.stock_mode,p.accepts_notes,p.category_id,c.name AS category_name
  FROM commerce_products p JOIN commerce_storefronts f ON f.store_id=p.store_id AND f.tenant_id=p.tenant_id
  LEFT JOIN commerce_categories c ON c.id=p.category_id
  WHERE f.slug=requested_slug AND commerce_public_store(requested_slug) IS NOT NULL
   AND p.active AND p.published AND (c.id IS NULL OR c.active)
   AND (coalesce(query_text,'')='' OR position(lower(left(query_text,160)) in lower(p.name))>0)
   AND (requested_category IS NULL OR p.category_id=requested_category)
   AND EXISTS(SELECT 1 FROM commerce_variants v WHERE v.product_id=p.id AND v.active)
 ), page AS (SELECT * FROM eligible ORDER BY name,id LIMIT greatest(1,least(page_limit,50)) OFFSET greatest(0,least(page_offset,100000)))
 SELECT jsonb_build_object('total',(SELECT count(*) FROM eligible),'data',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'id',p.id,'stockMode',p.stock_mode,'acceptsNotes',p.accepts_notes,'name',p.name,'description',p.description,'categoryId',p.category_id,'categoryName',p.category_name,
  'variants',(SELECT jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'attributes',jsonb_build_object('color',coalesce(v.attributes->>'color',''),'size',coalesce(v.attributes->>'size','')),'priceCents',v.price_cents,'available',(p.stock_mode='MADE_TO_ORDER' OR b.on_hand>b.reserved)) ORDER BY v.is_default DESC,v.name,v.id)
   FROM commerce_variants v JOIN commerce_inventory_balances b ON b.variant_id=v.id WHERE v.product_id=p.id AND v.active)
 ) ORDER BY p.name,p.id) FROM page p),'[]'::jsonb))
$$;


CREATE OR REPLACE FUNCTION commerce_cart_read(requested_cart uuid,owner_hash text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 WITH cart AS (
 SELECT c.*,f.slug,f.title,commerce_public_store(f.slug) IS NOT NULL AS store_available
 FROM commerce_guest_carts c JOIN commerce_storefronts f ON f.store_id=c.store_id AND f.tenant_id=c.tenant_id
 WHERE c.id=requested_cart AND c.token_hash=owner_hash
 ), items AS (
 SELECT i.*,p.id AS product_id,p.accepts_notes,
 (c.store_available AND p.active AND p.published AND v.active AND (category.id IS NULL OR category.active)) AS listed,
 v.price_cents,CASE WHEN p.stock_mode='MADE_TO_ORDER' THEN 99 ELSE b.on_hand-b.reserved END AS stock,
 CASE WHEN c.store_available AND p.active AND p.published AND v.active AND (category.id IS NULL OR category.active)
 THEN (SELECT img.id FROM commerce_product_images img WHERE img.product_id=p.id AND NOT img.archived ORDER BY img.position,img.id LIMIT 1) ELSE NULL END AS image_id
 FROM cart c JOIN commerce_cart_items i ON i.cart_id=c.id AND i.store_id=c.store_id AND i.tenant_id=c.tenant_id
 JOIN commerce_variants v ON v.id=i.variant_id AND v.store_id=i.store_id AND v.tenant_id=i.tenant_id
 JOIN commerce_products p ON p.id=v.product_id LEFT JOIN commerce_categories category ON category.id=p.category_id
 JOIN commerce_inventory_balances b ON b.variant_id=v.id
 ), projection AS (
 SELECT i.variant_id,i.quantity,i.product_name,i.variant_name,i.product_id,i.image_id,i.preparation_notes,i.accepts_notes,
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
 'preparationNotes',p.preparation_notes,'acceptsNotes',p.accepts_notes,'variantName',p.variant_name,'quantity',p.quantity,'unitPriceCents',p.display_price,'lineTotalCents',p.display_price::bigint*p.quantity,
 'priceChanged',p.price_changed,'status',p.status,'maxQuantity',p.max_quantity,'imageId',p.image_id) ORDER BY p.product_name,p.variant_name,p.variant_id) FROM projection p),'[]'::jsonb)) FROM cart c
$$;


-- Preserve the original cart API and its idempotency/version/stock controls.
-- Notes apply to all units on the existing variant line, never change its price.
CREATE FUNCTION commerce_cart_change_with_notes(requested_cart uuid,owner_hash text,requested_variant uuid,requested_quantity integer,expected_version integer,request_key text,payload_hash text,refresh_cart boolean,notes text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE cart commerce_guest_carts%ROWTYPE; replay boolean;
BEGIN
 SELECT * INTO cart FROM commerce_guest_carts WHERE id=requested_cart AND token_hash=owner_hash FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cart not found' USING ERRCODE='P0002'; END IF;
 SELECT EXISTS(SELECT 1 FROM commerce_cart_mutations m WHERE m.cart_id=cart.id AND m.request_key=commerce_cart_change_with_notes.request_key) INTO replay;
 IF NOT replay AND notes IS NOT NULL THEN
  IF refresh_cart OR requested_quantity IS NULL OR requested_quantity=0 OR char_length(notes)>500 THEN
   RAISE EXCEPTION 'Invalid preparation notes' USING ERRCODE='22023';
  END IF;
  IF trim(notes)<>'' AND NOT EXISTS(SELECT 1 FROM commerce_variants v JOIN commerce_products p ON p.id=v.product_id
   WHERE v.id=requested_variant AND v.store_id=cart.store_id AND v.tenant_id=cart.tenant_id AND p.accepts_notes)
  THEN RAISE EXCEPTION 'Notes not allowed' USING ERRCODE='22023'; END IF;
 END IF;
 PERFORM commerce_cart_change(requested_cart,owner_hash,requested_variant,requested_quantity,expected_version,request_key,payload_hash,refresh_cart);
 IF NOT replay AND notes IS NOT NULL THEN
  UPDATE commerce_cart_items SET preparation_notes=trim(notes) WHERE cart_id=requested_cart AND variant_id=requested_variant;
 END IF;
 RETURN commerce_cart_read(requested_cart,owner_hash);
END $$;
REVOKE ALL ON FUNCTION commerce_cart_change_with_notes(uuid,text,uuid,integer,integer,text,text,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_cart_change_with_notes(uuid,text,uuid,integer,integer,text,text,boolean,text) TO rastreia_runtime;

