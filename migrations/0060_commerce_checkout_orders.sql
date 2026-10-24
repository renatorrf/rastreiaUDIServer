SET LOCAL search_path TO rastreia,public;

CREATE TABLE commerce_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number bigserial UNIQUE,
 tenant_id uuid NOT NULL, store_id uuid NOT NULL, cart_id uuid NOT NULL UNIQUE REFERENCES commerce_guest_carts(id),
 customer_user_id uuid NOT NULL REFERENCES users(id), request_hash text NOT NULL,
 status text NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','CONFIRMED','COMPLETED','CANCELLED','EXPIRED')),
 fulfillment text NOT NULL CHECK(fulfillment IN ('DELIVERY','PICKUP')),
 customer_name text NOT NULL, whatsapp text NOT NULL, address jsonb,
 subtotal_cents bigint NOT NULL CHECK(subtotal_cents>=0), version integer NOT NULL DEFAULT 1,
 reservation_expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tenant_id,store_id), FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id)
);
CREATE TABLE commerce_order_items (
 order_id uuid NOT NULL, tenant_id uuid NOT NULL, store_id uuid NOT NULL, variant_id uuid NOT NULL,
 product_name text NOT NULL,variant_name text NOT NULL,sku text NOT NULL,attributes jsonb NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 99),unit_price_cents integer NOT NULL CHECK(unit_price_cents>=0),
 unit_cost_cents integer NOT NULL CHECK(unit_cost_cents>=0),stocked boolean NOT NULL,
 preparation_notes text NOT NULL CHECK(char_length(preparation_notes)<=500),
 PRIMARY KEY(order_id,variant_id),FOREIGN KEY(order_id,tenant_id,store_id) REFERENCES commerce_orders(id,tenant_id,store_id),
 FOREIGN KEY(variant_id,tenant_id,store_id) REFERENCES commerce_variants(id,tenant_id,store_id)
);
CREATE TABLE commerce_order_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES commerce_orders(id),
 status text NOT NULL,reason text NOT NULL DEFAULT '',actor_user_id uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commerce_orders_store_queue ON commerce_orders(store_id,status,created_at DESC);
CREATE INDEX commerce_orders_customer_history ON commerce_orders(customer_user_id,created_at DESC);
CREATE INDEX commerce_orders_expiry ON commerce_orders(reservation_expires_at) WHERE status='RECEIVED';
ALTER TABLE commerce_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_orders_read ON commerce_orders FOR SELECT USING(customer_user_id=current_user_id() OR (tenant_id=current_tenant_id() AND commerce_manage_store(store_id)));
ALTER TABLE commerce_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_order_items_read ON commerce_order_items FOR SELECT USING(EXISTS(SELECT 1 FROM commerce_orders o WHERE o.id=order_id));
ALTER TABLE commerce_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_order_events FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_order_events_read ON commerce_order_events FOR SELECT USING(EXISTS(SELECT 1 FROM commerce_orders o WHERE o.id=order_id));
REVOKE ALL ON commerce_orders,commerce_order_items,commerce_order_events FROM PUBLIC,rastreia_runtime;
GRANT SELECT ON commerce_orders,commerce_order_events TO rastreia_runtime;
GRANT SELECT(order_id,tenant_id,store_id,variant_id,product_name,variant_name,sku,attributes,quantity,unit_price_cents,stocked,preparation_notes) ON commerce_order_items TO rastreia_runtime;

-- A bounded DTO: never exposes cost, coordinates or cart credentials.
CREATE FUNCTION commerce_order_read(requested_order uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT jsonb_build_object('id',o.id,'number',o.number,'storeId',o.store_id,'storeName',s.name,'status',o.status,'fulfillment',o.fulfillment,
 'customerName',o.customer_name,'whatsapp',o.whatsapp,'address',o.address-'latitude'-'longitude','subtotalCents',o.subtotal_cents,
 'version',o.version,'createdAt',o.created_at,'reservationExpiresAt',o.reservation_expires_at,
 'items',coalesce((SELECT jsonb_agg(jsonb_build_object('variantId',i.variant_id,'productName',i.product_name,'variantName',i.variant_name,
 'sku',i.sku,'attributes',i.attributes,'quantity',i.quantity,'unitPriceCents',i.unit_price_cents,'lineTotalCents',i.unit_price_cents::bigint*i.quantity,
 'preparationNotes',i.preparation_notes) ORDER BY i.product_name,i.variant_name,i.variant_id) FROM commerce_order_items i WHERE i.order_id=o.id),'[]'::jsonb),
 'events',coalesce((SELECT jsonb_agg(jsonb_build_object('status',e.status,'reason',e.reason,'createdAt',e.created_at) ORDER BY e.created_at,e.id) FROM commerce_order_events e WHERE e.order_id=o.id),'[]'::jsonb))
 FROM commerce_orders o JOIN stores s ON s.id=o.store_id AND s.tenant_id=o.tenant_id
 WHERE o.id=requested_order AND (o.customer_user_id=current_user_id() OR (o.tenant_id=current_tenant_id() AND commerce_manage_store(o.store_id)))
$$;
REVOKE ALL ON FUNCTION commerce_order_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_order_read(uuid) TO rastreia_runtime;

-- Internal/worker only. All order writers serialize by store, then lock stock in variant order.
CREATE FUNCTION commerce_expire_store_orders(requested_store uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE ord record; item record; expired integer:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('commerce-orders:'||requested_store::text));
 FOR ord IN SELECT * FROM commerce_orders WHERE store_id=requested_store AND status='RECEIVED' AND reservation_expires_at<=now() ORDER BY id FOR UPDATE LOOP
  FOR item IN SELECT * FROM commerce_order_items WHERE order_id=ord.id AND stocked ORDER BY variant_id LOOP
   UPDATE commerce_inventory_balances SET reserved=reserved-item.quantity,version=version+1,updated_at=now() WHERE variant_id=item.variant_id;
  END LOOP;
  UPDATE commerce_orders SET status='EXPIRED',version=version+1,updated_at=now() WHERE id=ord.id;
  INSERT INTO commerce_order_events(order_id,status,reason) VALUES(ord.id,'EXPIRED','Prazo de confirmação da loja encerrado.');
  expired:=expired+1;
 END LOOP;
 RETURN expired;
END $$;
REVOKE ALL ON FUNCTION commerce_expire_store_orders(uuid) FROM PUBLIC,rastreia_runtime;

CREATE FUNCTION commerce_checkout(requested_cart uuid,owner_hash text,expected_version integer,payload_hash text,delivery_mode text,expected_profile uuid,expected_profile_updated timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE cart commerce_guest_carts%ROWTYPE; shop commerce_storefronts%ROWTYPE; profile customer_profiles%ROWTYPE; existing commerce_orders%ROWTYPE;
 item record; new_order_id uuid; total bigint:=0;
BEGIN
 IF current_user_id() IS NULL OR NOT EXISTS(SELECT 1 FROM users WHERE id=current_user_id() AND status='ACTIVE' AND NOT must_change_password)
 THEN RAISE EXCEPTION 'Customer login required' USING ERRCODE='42501'; END IF;
 SELECT * INTO cart FROM commerce_guest_carts WHERE id=requested_cart AND token_hash=owner_hash FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cart not found' USING ERRCODE='P0002'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('commerce-orders:'||cart.store_id::text));
 SELECT * INTO existing FROM commerce_orders WHERE cart_id=cart.id;
 IF FOUND THEN
  IF existing.customer_user_id<>current_user_id() THEN RAISE EXCEPTION 'Cart not found' USING ERRCODE='P0002'; END IF;
  IF existing.request_hash<>payload_hash THEN RAISE EXCEPTION 'Checkout differs' USING ERRCODE='23505'; END IF;
  RETURN commerce_order_read(existing.id);
 END IF;
 IF expected_version IS NULL OR cart.version<>expected_version THEN RAISE EXCEPTION 'Cart changed' USING ERRCODE='40001'; END IF;
 IF cart.expires_at<=now() THEN RAISE EXCEPTION 'Cart expired' USING ERRCODE='55000'; END IF;
 IF delivery_mode IS NULL OR delivery_mode NOT IN ('PICKUP','DELIVERY') OR payload_hash IS NULL OR payload_hash !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'Invalid checkout' USING ERRCODE='22023'; END IF;
 SELECT * INTO profile FROM customer_profiles WHERE id=expected_profile AND user_id=current_user_id() AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Customer profile required' USING ERRCODE='42501'; END IF;
 IF expected_profile_updated IS NULL OR profile.updated_at<>expected_profile_updated THEN RAISE EXCEPTION 'Profile changed' USING ERRCODE='40001'; END IF;
 IF delivery_mode='DELIVERY' AND (coalesce(trim(profile.address_line),'')='' OR coalesce(trim(profile.address_number),'')='' OR coalesce(trim(profile.city),'')='' OR profile.latitude IS NULL OR profile.longitude IS NULL)
 THEN RAISE EXCEPTION 'Address required' USING ERRCODE='22023'; END IF;
 SELECT * INTO shop FROM commerce_storefronts WHERE store_id=cart.store_id AND tenant_id=cart.tenant_id FOR SHARE;
 IF NOT FOUND OR commerce_public_store(shop.slug) IS NULL THEN RAISE EXCEPTION 'Store unavailable' USING ERRCODE='P0002'; END IF;
 PERFORM commerce_expire_store_orders(cart.store_id);
 IF NOT EXISTS(SELECT 1 FROM commerce_cart_items WHERE cart_id=cart.id) THEN RAISE EXCEPTION 'Empty cart' USING ERRCODE='22023'; END IF;
 -- Same lock order as product/default-variant edits; prevent a price change halfway through checkout.
 PERFORM p.id FROM commerce_products p WHERE p.id IN (SELECT v.product_id FROM commerce_cart_items i JOIN commerce_variants v ON v.id=i.variant_id WHERE i.cart_id=cart.id) ORDER BY p.id FOR SHARE;
 PERFORM v.id FROM commerce_variants v JOIN commerce_cart_items i ON i.variant_id=v.id WHERE i.cart_id=cart.id ORDER BY v.id FOR SHARE OF v;
 FOR item IN SELECT i.*,v.price_cents,p.active AS product_active,p.published,p.accepts_notes,p.stock_mode,v.active AS variant_active,c.active AS category_active,
  b.on_hand-b.reserved AS available FROM commerce_cart_items i JOIN commerce_variants v ON v.id=i.variant_id JOIN commerce_products p ON p.id=v.product_id
  LEFT JOIN commerce_categories c ON c.id=p.category_id JOIN commerce_inventory_balances b ON b.variant_id=v.id
  WHERE i.cart_id=cart.id ORDER BY i.variant_id FOR UPDATE OF b LOOP
  IF NOT item.product_active OR NOT item.published OR NOT item.variant_active OR item.category_active=false OR (item.preparation_notes<>'' AND NOT item.accepts_notes)
  THEN RAISE EXCEPTION 'Item unavailable' USING ERRCODE='P0001'; END IF;
  IF item.price_cents<>item.unit_price_cents THEN RAISE EXCEPTION 'Price changed' USING ERRCODE='40001'; END IF;
  IF item.stock_mode='STOCKED' AND item.available<item.quantity THEN RAISE EXCEPTION 'Insufficient stock' USING ERRCODE='23514'; END IF;
  total:=total+item.quantity::bigint*item.price_cents;
 END LOOP;
 INSERT INTO commerce_orders(tenant_id,store_id,cart_id,customer_user_id,request_hash,fulfillment,customer_name,whatsapp,address,subtotal_cents)
 VALUES(cart.tenant_id,cart.store_id,cart.id,current_user_id(),payload_hash,delivery_mode,profile.first_name||' '||profile.last_name,profile.whatsapp_normalized,
 CASE WHEN delivery_mode='DELIVERY' THEN jsonb_build_object('addressLine',profile.address_line,'addressNumber',profile.address_number,'complement',profile.complement,
 'neighborhood',profile.neighborhood,'city',profile.city,'state',profile.state,'postalCode',profile.postal_code,'latitude',profile.latitude,'longitude',profile.longitude) ELSE NULL END,total) RETURNING id INTO new_order_id;
 INSERT INTO commerce_order_items(order_id,tenant_id,store_id,variant_id,product_name,variant_name,sku,attributes,quantity,unit_price_cents,unit_cost_cents,stocked,preparation_notes)
 SELECT new_order_id,i.tenant_id,i.store_id,i.variant_id,p.name,v.name,v.sku,jsonb_build_object('size',coalesce(v.attributes->>'size',''),'color',coalesce(v.attributes->>'color','')),
 i.quantity,v.price_cents,v.cost_cents,p.stock_mode='STOCKED',i.preparation_notes FROM commerce_cart_items i JOIN commerce_variants v ON v.id=i.variant_id JOIN commerce_products p ON p.id=v.product_id WHERE i.cart_id=cart.id;
 UPDATE commerce_inventory_balances b SET reserved=b.reserved+i.quantity,version=b.version+1,updated_at=now() FROM commerce_order_items i WHERE i.order_id=new_order_id AND i.stocked AND b.variant_id=i.variant_id;
 INSERT INTO commerce_order_events(order_id,status,actor_user_id) VALUES(new_order_id,'RECEIVED',current_user_id());
 UPDATE commerce_guest_carts SET version=version+1,updated_at=now() WHERE id=cart.id;
 RETURN commerce_order_read(new_order_id);
END $$;
REVOKE ALL ON FUNCTION commerce_checkout(uuid,text,integer,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_checkout(uuid,text,integer,text,text,uuid,timestamptz) TO rastreia_runtime;

CREATE FUNCTION commerce_order_transition(requested_order uuid,requested_store uuid,expected_version integer,next_status text,change_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE ord commerce_orders%ROWTYPE; item record; balance commerce_inventory_balances%ROWTYPE; delta integer;
BEGIN
 IF NOT commerce_manage_store(requested_store) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('commerce-orders:'||requested_store::text));
 PERFORM commerce_expire_store_orders(requested_store);
 SELECT * INTO ord FROM commerce_orders WHERE id=requested_order AND store_id=requested_store AND tenant_id=current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
 IF ord.status='EXPIRED' THEN RETURN commerce_order_read(ord.id); END IF;
 IF expected_version IS NULL OR expected_version<>ord.version THEN RAISE EXCEPTION 'Order changed' USING ERRCODE='40001'; END IF;
 IF next_status IS NULL OR NOT ((ord.status='RECEIVED' AND next_status IN ('CONFIRMED','CANCELLED')) OR (ord.status='CONFIRMED' AND next_status IN ('COMPLETED','CANCELLED')))
 THEN RAISE EXCEPTION 'Invalid transition' USING ERRCODE='22023'; END IF;
 IF next_status='CANCELLED' AND (change_reason IS NULL OR char_length(trim(change_reason)) NOT BETWEEN 5 AND 500) THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT * FROM commerce_order_items WHERE order_id=ord.id AND stocked ORDER BY variant_id LOOP
  SELECT * INTO balance FROM commerce_inventory_balances WHERE variant_id=item.variant_id FOR UPDATE;
  delta:=CASE WHEN next_status='CONFIRMED' THEN -item.quantity WHEN next_status='CANCELLED' AND ord.status='CONFIRMED' THEN item.quantity ELSE 0 END;
  UPDATE commerce_inventory_balances SET on_hand=on_hand+delta,reserved=reserved-CASE WHEN ord.status='RECEIVED' THEN item.quantity ELSE 0 END,version=version+1,updated_at=now() WHERE variant_id=item.variant_id;
  IF delta<>0 THEN
   INSERT INTO commerce_inventory_movements(tenant_id,store_id,variant_id,kind,delta,before_quantity,after_quantity,reason,actor_user_id)
   VALUES(ord.tenant_id,ord.store_id,item.variant_id,CASE WHEN delta<0 THEN 'EXIT' ELSE 'RETURN' END,delta,balance.on_hand,balance.on_hand+delta,'Pedido catálogo #'||ord.number||': '||next_status,current_user_id());
  END IF;
 END LOOP;
 UPDATE commerce_orders SET status=next_status,version=version+1,updated_at=now() WHERE id=ord.id;
 INSERT INTO commerce_order_events(order_id,status,reason,actor_user_id) VALUES(ord.id,next_status,coalesce(trim(change_reason),''),current_user_id());
 RETURN commerce_order_read(ord.id);
END $$;
REVOKE ALL ON FUNCTION commerce_order_transition(uuid,uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_order_transition(uuid,uuid,integer,text,text) TO rastreia_runtime;

-- Freeze converted carts even for old clients; the next purchase must use a new cart.
ALTER FUNCTION commerce_cart_change(uuid,text,uuid,integer,integer,text,text,boolean) RENAME TO commerce_cart_change_before_checkout;
CREATE OR REPLACE FUNCTION commerce_cart_change_before_checkout(requested_cart uuid,owner_hash text,requested_variant uuid,requested_quantity integer,expected_version integer,request_key text,payload_hash text,refresh_cart boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE cart commerce_guest_carts%ROWTYPE; previous_hash text; item record; item_count integer;
BEGIN
 IF expected_version IS NULL OR expected_version<1 OR request_key IS NULL OR char_length(request_key) NOT BETWEEN 8 AND 100
 OR payload_hash IS NULL OR payload_hash !~ '^[a-f0-9]{64}$' OR refresh_cart IS NULL
 OR (NOT refresh_cart AND (requested_variant IS NULL OR requested_quantity IS NULL OR requested_quantity NOT BETWEEN 0 AND 99))
 THEN RAISE EXCEPTION 'Invalid cart change' USING ERRCODE='22023'; END IF;
 SELECT * INTO cart FROM commerce_guest_carts WHERE id=requested_cart AND token_hash=owner_hash FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cart not found' USING ERRCODE='P0002'; END IF;
 SELECT m.request_hash INTO previous_hash FROM commerce_cart_mutations m WHERE m.cart_id=cart.id AND m.request_key=commerce_cart_change_before_checkout.request_key;
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
REVOKE ALL ON FUNCTION commerce_cart_change_before_checkout(uuid,text,uuid,integer,integer,text,text,boolean) FROM PUBLIC,rastreia_runtime;
CREATE FUNCTION commerce_cart_change(requested_cart uuid,owner_hash text,requested_variant uuid,requested_quantity integer,expected_version integer,request_key text,payload_hash text,refresh_cart boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
BEGIN
 PERFORM id FROM commerce_guest_carts WHERE id=requested_cart AND token_hash=owner_hash FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cart not found' USING ERRCODE='P0002'; END IF;
 PERFORM id FROM commerce_guest_carts WHERE id=requested_cart AND token_hash=owner_hash FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cart not found' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM commerce_orders WHERE cart_id=requested_cart) THEN RAISE EXCEPTION 'Cart submitted' USING ERRCODE='55000'; END IF;
 RETURN commerce_cart_change_before_checkout(requested_cart,owner_hash,requested_variant,requested_quantity,expected_version,request_key,payload_hash,refresh_cart);
END $$;
REVOKE ALL ON FUNCTION commerce_cart_change(uuid,text,uuid,integer,integer,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_cart_change(uuid,text,uuid,integer,integer,text,text,boolean) TO rastreia_runtime;
ALTER FUNCTION commerce_cart_read(uuid,text) RENAME TO commerce_cart_read_before_checkout;
REVOKE ALL ON FUNCTION commerce_cart_read_before_checkout(uuid,text) FROM PUBLIC,rastreia_runtime;
CREATE FUNCTION commerce_cart_read(requested_cart uuid,owner_hash text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT commerce_cart_read_before_checkout(requested_cart,owner_hash)||jsonb_build_object('checkoutOrderId',(SELECT o.id FROM commerce_orders o JOIN commerce_guest_carts c ON c.id=o.cart_id WHERE c.id=requested_cart AND c.token_hash=owner_hash))
$$;
REVOKE ALL ON FUNCTION commerce_cart_read(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_cart_read(uuid,text) TO rastreia_runtime;
