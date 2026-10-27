SET LOCAL search_path=rastreia,public;

CREATE TABLE commerce_payment_settings (
 store_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 delivery_fee_cents integer NOT NULL DEFAULT 0 CHECK(delivery_fee_cents BETWEEN 0 AND 1000000),
 version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id)
);
ALTER TABLE commerce_payment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_payment_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY manager_scope ON commerce_payment_settings USING(tenant_id=current_tenant_id() AND commerce_manage_store(store_id))
 WITH CHECK(tenant_id=current_tenant_id() AND commerce_manage_store(store_id));
GRANT SELECT,INSERT,UPDATE ON commerce_payment_settings TO rastreia_runtime;

ALTER TABLE commerce_orders DROP CONSTRAINT commerce_orders_status_check;
ALTER TABLE commerce_orders ADD CONSTRAINT commerce_orders_status_check CHECK(status IN ('WAITING_PAYMENT','RECEIVED','CONFIRMED','COMPLETED','CANCELLED','EXPIRED'));
ALTER TABLE commerce_orders ADD COLUMN delivery_fee_cents integer NOT NULL DEFAULT 0 CHECK(delivery_fee_cents>=0);
ALTER TABLE commerce_orders ADD COLUMN payment_method text NOT NULL DEFAULT 'ARRANGE' CHECK(payment_method IN ('ARRANGE','PIX'));
CREATE TABLE commerce_pix_payments (
 order_id uuid PRIMARY KEY REFERENCES commerce_orders(id),
 status text NOT NULL DEFAULT 'CREATED' CHECK(status IN ('CREATED','REQUESTED','PENDING','PAID','EXPIRED','REVIEW_REQUIRED')),
 company_id uuid NOT NULL REFERENCES companies(id),settings_version integer,
 tax_id text,pix_key text,provider_id text,tx_id text,location_id text,emv text,
 expires_at timestamptz NOT NULL,paid_at timestamptz,paid_amount_cents bigint,end_to_end_id text,
 refund_required boolean NOT NULL DEFAULT false,review_reason text,
 next_check_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,provider_id),UNIQUE(end_to_end_id)
);
ALTER TABLE commerce_pix_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_pix_payments FORCE ROW LEVEL SECURITY;
-- Only trusted server/worker code can inspect raw bank references and change payment state.
REVOKE ALL ON commerce_pix_payments FROM PUBLIC,rastreia_runtime;
CREATE INDEX commerce_pix_due ON commerce_pix_payments(next_check_at) WHERE paid_at IS NULL;

ALTER FUNCTION commerce_order_read(uuid) RENAME TO commerce_order_read_before_pix;
REVOKE ALL ON FUNCTION commerce_order_read_before_pix(uuid) FROM PUBLIC,rastreia_runtime;
CREATE FUNCTION commerce_order_read(requested_order uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT commerce_order_read_before_pix(o.id)||jsonb_build_object('deliveryFeeCents',o.delivery_fee_cents,
 'totalCents',o.subtotal_cents+o.delivery_fee_cents,'paymentMethod',o.payment_method,'payment',
 (SELECT jsonb_build_object('status',p.status,'expiresAt',p.expires_at,'paidAt',p.paid_at,'refundRequired',p.refund_required,
 'copyPaste',CASE WHEN p.status='PENDING' AND p.expires_at>now() AND o.status='WAITING_PAYMENT' THEN p.emv ELSE NULL END)
 FROM commerce_pix_payments p WHERE p.order_id=o.id))
 FROM commerce_orders o WHERE o.id=requested_order
 AND (o.customer_user_id=current_user_id() OR (o.tenant_id=current_tenant_id() AND commerce_manage_store(o.store_id)))
$$;
REVOKE ALL ON FUNCTION commerce_order_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_order_read(uuid) TO rastreia_runtime;

CREATE FUNCTION commerce_payment_quote(requested_cart uuid,owner_hash text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT jsonb_build_object('enabled',coalesce(s.enabled,false),'version',coalesce(s.version,0),'deliveryFeeCents',coalesce(s.delivery_fee_cents,0))
 FROM commerce_guest_carts c LEFT JOIN commerce_payment_settings s ON s.store_id=c.store_id
 WHERE c.id=requested_cart AND c.token_hash=owner_hash
$$;
REVOKE ALL ON FUNCTION commerce_payment_quote(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_payment_quote(uuid,text) TO rastreia_runtime;

ALTER FUNCTION commerce_checkout(uuid,text,integer,text,text,uuid,timestamptz) RENAME TO commerce_checkout_before_pix;
REVOKE ALL ON FUNCTION commerce_checkout_before_pix(uuid,text,integer,text,text,uuid,timestamptz) FROM PUBLIC,rastreia_runtime;
CREATE FUNCTION commerce_checkout_with_payment(requested_cart uuid,owner_hash text,expected_version integer,payload_hash text,delivery_mode text,expected_profile uuid,expected_profile_updated timestamptz,payment_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE cart commerce_guest_carts%ROWTYPE; settings commerce_payment_settings%ROWTYPE; result jsonb; new_order_id uuid; existing commerce_orders%ROWTYPE;
BEGIN
 SELECT * INTO cart FROM commerce_guest_carts WHERE id=requested_cart AND token_hash=owner_hash FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cart not found' USING ERRCODE='P0002'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('commerce-orders:'||cart.store_id::text));
 SELECT * INTO existing FROM commerce_orders WHERE cart_id=cart.id;
 IF FOUND THEN RETURN commerce_checkout_before_pix(requested_cart,owner_hash,expected_version,payload_hash,delivery_mode,expected_profile,expected_profile_updated); END IF;
 SELECT * INTO settings FROM commerce_payment_settings WHERE store_id=cart.store_id FOR SHARE;
 IF (payment_version IS NULL AND coalesce(settings.enabled,false)) OR (payment_version IS NOT NULL AND payment_version<>coalesce(settings.version,0))
 THEN RAISE EXCEPTION 'Payment settings changed' USING ERRCODE='40001'; END IF;
 result:=commerce_checkout_before_pix(requested_cart,owner_hash,expected_version,payload_hash,delivery_mode,expected_profile,expected_profile_updated);
 new_order_id:=(result->>'id')::uuid;
 IF coalesce(settings.enabled,false) THEN
  IF (result->>'subtotalCents')::bigint+(CASE WHEN delivery_mode='DELIVERY' THEN settings.delivery_fee_cents ELSE 0 END)<=0 THEN RAISE EXCEPTION 'Pix amount must be positive' USING ERRCODE='22023'; END IF;
  UPDATE commerce_orders SET status='WAITING_PAYMENT',payment_method='PIX',delivery_fee_cents=CASE WHEN delivery_mode='DELIVERY' THEN settings.delivery_fee_cents ELSE 0 END,
   reservation_expires_at=now()+interval '15 minutes' WHERE id=new_order_id;
  UPDATE commerce_order_events SET status='WAITING_PAYMENT' WHERE commerce_order_events.order_id=new_order_id;
  INSERT INTO commerce_pix_payments(order_id,company_id,expires_at) SELECT o.id,s.company_id,o.reservation_expires_at FROM commerce_orders o JOIN stores s ON s.id=o.store_id WHERE o.id=new_order_id;
 END IF;
 RETURN commerce_order_read(new_order_id);
END $$;
REVOKE ALL ON FUNCTION commerce_checkout_with_payment(uuid,text,integer,text,text,uuid,timestamptz,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_checkout_with_payment(uuid,text,integer,text,text,uuid,timestamptz,integer) TO rastreia_runtime;
CREATE FUNCTION commerce_checkout(requested_cart uuid,owner_hash text,expected_version integer,payload_hash text,delivery_mode text,expected_profile uuid,expected_profile_updated timestamptz)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT commerce_checkout_with_payment(requested_cart,owner_hash,expected_version,payload_hash,delivery_mode,expected_profile,expected_profile_updated,NULL)
$$;
REVOKE ALL ON FUNCTION commerce_checkout(uuid,text,integer,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_checkout(uuid,text,integer,text,text,uuid,timestamptz) TO rastreia_runtime;

CREATE OR REPLACE FUNCTION commerce_expire_store_orders(requested_store uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE ord record; item record; expired integer:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('commerce-orders:'||requested_store::text));
 FOR ord IN SELECT * FROM commerce_orders WHERE store_id=requested_store AND reservation_expires_at<=now()
 AND (status='WAITING_PAYMENT' OR (status='RECEIVED' AND payment_method='ARRANGE')) ORDER BY id FOR UPDATE LOOP
  FOR item IN SELECT * FROM commerce_order_items WHERE order_id=ord.id AND stocked ORDER BY variant_id LOOP
   UPDATE commerce_inventory_balances SET reserved=reserved-item.quantity,version=version+1,updated_at=now() WHERE variant_id=item.variant_id;
  END LOOP;
  UPDATE commerce_orders SET status='EXPIRED',version=version+1,updated_at=now() WHERE id=ord.id;
  UPDATE commerce_pix_payments SET status=CASE WHEN status='REVIEW_REQUIRED' THEN status ELSE 'EXPIRED' END WHERE order_id=ord.id AND paid_at IS NULL;
  INSERT INTO commerce_order_events(order_id,status,reason) VALUES(ord.id,'EXPIRED',CASE WHEN ord.payment_method='PIX' THEN 'Prazo do Pix encerrado. Não pague este código.' ELSE 'Prazo de confirmação da loja encerrado.' END);
  expired:=expired+1;
 END LOOP;
 RETURN expired;
END $$;

-- Bank-confirmed money is cash immediately; revenue remains recognized on completion.
CREATE FUNCTION commerce_pix_settle(requested_order uuid,bank_cents bigint,bank_e2e text,bank_paid_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE ord commerce_orders%ROWTYPE; payment commerce_pix_payments%ROWTYPE; entry_id uuid; day date; previous_actor text;
BEGIN
 SELECT * INTO ord FROM commerce_orders WHERE id=requested_order;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('commerce-orders:'||ord.store_id::text));
 SELECT * INTO ord FROM commerce_orders WHERE id=requested_order FOR UPDATE;
 SELECT * INTO payment FROM commerce_pix_payments WHERE order_id=ord.id FOR UPDATE;
 IF NOT FOUND OR payment.paid_at IS NOT NULL THEN RETURN; END IF;
 IF bank_cents IS NULL OR bank_cents<=0 OR bank_e2e IS NULL OR length(bank_e2e)<10 OR bank_paid_at IS NULL OR bank_paid_at>now()+interval '5 minutes' THEN RAISE EXCEPTION 'Invalid bank payment'; END IF;
 UPDATE commerce_pix_payments SET paid_at=bank_paid_at,paid_amount_cents=bank_cents,end_to_end_id=bank_e2e,
 status=CASE WHEN ord.status='WAITING_PAYMENT' AND bank_cents=ord.subtotal_cents+ord.delivery_fee_cents AND bank_paid_at<=payment.expires_at THEN 'PAID' ELSE 'REVIEW_REQUIRED' END,
 refund_required=(ord.status<>'WAITING_PAYMENT' OR bank_cents<>ord.subtotal_cents+ord.delivery_fee_cents OR bank_paid_at>payment.expires_at)
 WHERE order_id=ord.id;
 day:=(bank_paid_at AT TIME ZONE 'America/Sao_Paulo')::date;
 previous_actor:=current_setting('app.user_id',true);PERFORM set_config('app.user_id',ord.customer_user_id::text,true);
 INSERT INTO commerce_finance_entries(tenant_id,store_id,order_id,description,direction,dre_group,amount_cents,competence_date,due_date,created_by)
 VALUES(ord.tenant_id,ord.store_id,ord.id,'Pix do pedido #'||ord.number,'IN','CASH_ONLY',bank_cents,day,day,ord.customer_user_id) RETURNING id INTO entry_id;
 INSERT INTO commerce_finance_settlements(tenant_id,store_id,entry_id,amount_cents,paid_date,method,note,created_by)
 VALUES(ord.tenant_id,ord.store_id,entry_id,bank_cents,day,'PIX','Confirmação bancária BTG',ord.customer_user_id);
 PERFORM set_config('app.user_id',coalesce(previous_actor,''),true);
 IF (SELECT status='PAID' FROM commerce_pix_payments WHERE order_id=ord.id) THEN
  UPDATE commerce_orders SET status='RECEIVED',version=version+1,updated_at=now() WHERE id=ord.id;
  INSERT INTO commerce_order_events(order_id,status,reason) VALUES(ord.id,'RECEIVED','Pix confirmado pelo banco. Pedido liberado para a loja.');
 ELSE
  INSERT INTO commerce_order_events(order_id,status,reason) VALUES(ord.id,ord.status,'Pagamento requer conferência da loja; não houve liberação automática.');
 END IF;
END $$;
REVOKE ALL ON FUNCTION commerce_pix_settle(uuid,bigint,text,timestamptz) FROM PUBLIC,rastreia_runtime;

ALTER FUNCTION commerce_order_transition(uuid,uuid,integer,text,text) RENAME TO commerce_order_transition_before_pix;
REVOKE ALL ON FUNCTION commerce_order_transition_before_pix(uuid,uuid,integer,text,text) FROM PUBLIC,rastreia_runtime;
CREATE FUNCTION commerce_order_transition(requested_order uuid,requested_store uuid,expected_version integer,next_status text,change_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
BEGIN
 IF NOT commerce_manage_store(requested_store) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('commerce-orders:'||requested_store::text));
 IF EXISTS(SELECT 1 FROM commerce_orders o WHERE o.id=requested_order AND o.store_id=requested_store AND o.payment_method='PIX'
 AND NOT EXISTS(SELECT 1 FROM commerce_pix_payments p WHERE p.order_id=o.id AND p.status='PAID')) THEN RAISE EXCEPTION 'Payment not confirmed' USING ERRCODE='22023'; END IF;
 PERFORM commerce_order_transition_before_pix(requested_order,requested_store,expected_version,next_status,change_reason);
 IF next_status='CANCELLED' THEN UPDATE commerce_pix_payments SET refund_required=true WHERE order_id=requested_order AND paid_at IS NOT NULL; END IF;
 RETURN commerce_order_read(requested_order);
END $$;
REVOKE ALL ON FUNCTION commerce_order_transition(uuid,uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_order_transition(uuid,uuid,integer,text,text) TO rastreia_runtime;

CREATE OR REPLACE FUNCTION commerce_finance_recognize_sale() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE day date:=(now() AT TIME ZONE 'America/Sao_Paulo')::date; total bigint:=NEW.subtotal_cents+NEW.delivery_fee_cents;
BEGIN
 IF NEW.status='COMPLETED' AND OLD.status<>'COMPLETED' THEN
  INSERT INTO commerce_finance_sales(order_id,tenant_id,store_id,recognized_date,revenue_cents,known_cost_cents,unknown_cost_items)
  SELECT NEW.id,NEW.tenant_id,NEW.store_id,day,total,coalesce(round(sum(quantity*financial_unit_cost_cents)),0),count(*) FILTER(WHERE financial_unit_cost_cents IS NULL)
  FROM commerce_order_items WHERE order_id=NEW.id;
  IF total>0 THEN
   INSERT INTO commerce_finance_entries(tenant_id,store_id,order_id,description,direction,dre_group,amount_cents,competence_date,due_date,created_by)
   VALUES(NEW.tenant_id,NEW.store_id,NEW.id,'Pedido #'||NEW.number||' · '||left(NEW.customer_name,120),'IN','REVENUE',total,day,day,current_user_id())
   ON CONFLICT(order_id) DO UPDATE SET dre_group='REVENUE',competence_date=day,version=commerce_finance_entries.version+1;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION commerce_pix_protect_cash() RETURNS trigger LANGUAGE plpgsql SET search_path=rastreia,public,pg_temp AS $$
BEGIN
 IF current_user='rastreia_runtime' AND EXISTS(SELECT 1 FROM commerce_finance_entries e JOIN commerce_orders o ON o.id=e.order_id WHERE e.id=OLD.entry_id AND o.payment_method='PIX')
 THEN RAISE EXCEPTION 'Bank-confirmed settlement requires bank refund reconciliation' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION commerce_pix_protect_cash() FROM PUBLIC;
CREATE TRIGGER commerce_pix_protect_cash BEFORE UPDATE ON commerce_finance_settlements FOR EACH ROW EXECUTE PROCEDURE commerce_pix_protect_cash();
