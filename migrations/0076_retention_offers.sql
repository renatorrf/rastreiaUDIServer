SET LOCAL search_path=rastreia,public;
CREATE TABLE retention_preferences (
 store_id uuid NOT NULL REFERENCES stores(id), user_id uuid NOT NULL REFERENCES users(id),
 whatsapp text NOT NULL CHECK(whatsapp ~ '^55[0-9]{10,11}$'), enabled boolean NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(store_id,user_id)
);
CREATE TABLE retention_whatsapp_stops (
 phone_key text PRIMARY KEY, stopped_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON retention_whatsapp_stops FROM PUBLIC,rastreia_runtime;
CREATE FUNCTION retention_check_optin() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
BEGIN
 IF NEW.enabled THEN
   PERFORM pg_advisory_xact_lock(hashtext('retention-phone:'||NEW.whatsapp));
   IF EXISTS(SELECT 1 FROM retention_whatsapp_stops WHERE phone_key=NEW.whatsapp) THEN
     RAISE EXCEPTION 'Number opted out' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION retention_check_optin() FROM PUBLIC;
CREATE TRIGGER retention_guard_optin BEFORE INSERT OR UPDATE ON retention_preferences FOR EACH ROW EXECUTE PROCEDURE retention_check_optin();
CREATE TABLE retention_offers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), store_id uuid NOT NULL REFERENCES stores(id),
 user_id uuid NOT NULL REFERENCES users(id), approved_by uuid NOT NULL REFERENCES users(id),
 product_id uuid NOT NULL, product_name text NOT NULL, store_name text NOT NULL, slug text NOT NULL,
 first_name text NOT NULL, percent integer NOT NULL CHECK(percent BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 order_id uuid UNIQUE REFERENCES commerce_orders(id), discount_cents bigint,
 dispatch text NOT NULL CHECK(dispatch IN ('APP','QUEUED','PROCESSING','ACCEPTED','SKIPPED','FAILED','UNKNOWN')),
 FOREIGN KEY(product_id) REFERENCES commerce_products(id)
);
CREATE INDEX retention_offer_customer ON retention_offers(user_id,store_id,created_at DESC);
CREATE INDEX retention_offer_queue ON retention_offers(created_at) WHERE dispatch='QUEUED';
ALTER TABLE retention_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY retention_pref_read ON retention_preferences FOR SELECT USING(user_id=current_user_id() OR commerce_manage_store(store_id));
CREATE POLICY retention_pref_write ON retention_preferences FOR ALL USING(user_id=current_user_id()) WITH CHECK(user_id=current_user_id());
GRANT SELECT,INSERT,UPDATE ON retention_preferences TO rastreia_runtime;
ALTER TABLE retention_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_offers FORCE ROW LEVEL SECURITY;
CREATE POLICY retention_offer_read ON retention_offers FOR SELECT USING(user_id=current_user_id() OR commerce_manage_store(store_id));
CREATE POLICY retention_offer_issue ON retention_offers FOR INSERT WITH CHECK(commerce_manage_store(store_id) AND approved_by=current_user_id());
GRANT SELECT,INSERT ON retention_offers TO rastreia_runtime;

-- Called in the same transaction as checkout. A retry can only return the same order.
CREATE FUNCTION retention_apply(requested_offer uuid,requested_order uuid,expected_discount bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE f retention_offers%ROWTYPE; o commerce_orders%ROWTYPE; discount bigint;
BEGIN
 SELECT * INTO o FROM commerce_orders WHERE id=requested_order AND customer_user_id=current_user_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO f FROM retention_offers WHERE id=requested_offer AND user_id=current_user_id() AND store_id=o.store_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Offer unavailable' USING ERRCODE='P0002'; END IF;
 IF f.order_id=o.id THEN RETURN commerce_order_read(o.id); END IF;
 IF f.order_id IS NOT NULL OR f.expires_at<=clock_timestamp() OR o.status<>'RECEIVED' OR o.flow_version<>2
 OR NOT EXISTS(SELECT 1 FROM commerce_orders WHERE id=o.id AND xmin::text=(txid_current()%4294967296)::text)
 OR EXISTS(SELECT 1 FROM retention_offers WHERE order_id=o.id) THEN RAISE EXCEPTION 'Offer unavailable' USING ERRCODE='40001'; END IF;
 SELECT round(min(i.unit_price_cents)::numeric*f.percent/100)::bigint INTO discount FROM commerce_order_items i
 JOIN commerce_variants v ON v.id=i.variant_id WHERE i.order_id=o.id AND v.product_id=f.product_id;
 IF discount IS NULL OR discount<=0 OR discount IS DISTINCT FROM expected_discount OR discount>o.subtotal_cents
 OR (o.payment_method='PIX' AND o.subtotal_cents+o.delivery_fee_cents-discount<=0)
 THEN RAISE EXCEPTION 'Review offer' USING ERRCODE='22023'; END IF;
 UPDATE commerce_orders SET subtotal_cents=subtotal_cents-discount WHERE id=o.id;
 UPDATE retention_offers SET order_id=o.id,discount_cents=discount WHERE id=f.id;
 INSERT INTO commerce_order_events(order_id,status,reason,actor_user_id) VALUES(o.id,o.status,'Oferta aplicada em uma unidade de '||f.product_name||': desconto de R$ '||replace(to_char(discount/100.0,'FM999999990.00'),'.',','),current_user_id());
 RETURN commerce_order_read(o.id);
END $$;
REVOKE ALL ON FUNCTION retention_apply(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention_apply(uuid,uuid,bigint) TO rastreia_runtime;
