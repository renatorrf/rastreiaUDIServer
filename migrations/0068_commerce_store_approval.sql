SET LOCAL search_path=rastreia,public;

-- Existing orders keep their original contract. New checkouts require store approval.
ALTER TABLE commerce_orders ADD COLUMN flow_version integer NOT NULL DEFAULT 1 CHECK(flow_version IN(1,2));
ALTER TABLE commerce_orders ADD COLUMN approved_by uuid REFERENCES users(id);
ALTER TABLE commerce_orders ADD COLUMN delivery_id uuid UNIQUE REFERENCES deliveries(id);
ALTER TABLE commerce_orders ADD COLUMN fulfillment_next_check timestamptz NOT NULL DEFAULT now();
ALTER TABLE commerce_orders DROP CONSTRAINT commerce_orders_payment_method_check;
ALTER TABLE commerce_orders ADD CONSTRAINT commerce_orders_payment_method_check CHECK(payment_method IN('ARRANGE','PIX','CARD_PRESENT'));
ALTER TABLE commerce_orders DROP CONSTRAINT commerce_orders_status_check;
ALTER TABLE commerce_orders ADD CONSTRAINT commerce_orders_status_check CHECK(status IN('RECEIVED','WAITING_PAYMENT','CONFIRMED','READY_PICKUP','COMPLETED','CANCELLED','EXPIRED'));
CREATE INDEX commerce_orders_fulfillment_pending ON commerce_orders(fulfillment_next_check,id) WHERE flow_version=2 AND status='CONFIRMED' AND fulfillment='DELIVERY';

ALTER FUNCTION commerce_order_read(uuid) RENAME TO commerce_order_read_before_approval;
REVOKE ALL ON FUNCTION commerce_order_read_before_approval(uuid) FROM PUBLIC,rastreia_runtime;
CREATE FUNCTION commerce_order_read(requested_order uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT commerce_order_read_before_approval(o.id)||jsonb_build_object('flowVersion',o.flow_version,'deliveryId',o.delivery_id,
 'deliveryStatus',(SELECT d.status::text FROM deliveries d WHERE d.id=o.delivery_id AND d.store_id=o.store_id AND d.tenant_id=o.tenant_id))
 FROM commerce_orders o WHERE o.id=requested_order AND (o.customer_user_id=current_user_id() OR (o.tenant_id=current_tenant_id() AND commerce_manage_store(o.store_id)))
$$;
REVOKE ALL ON FUNCTION commerce_order_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_order_read(uuid) TO rastreia_runtime;

CREATE FUNCTION commerce_checkout_for_approval(requested_cart uuid,owner_hash text,expected_version integer,payload_hash text,delivery_mode text,expected_profile uuid,expected_profile_updated timestamptz,payment_version integer,chosen_method text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE cart commerce_guest_carts%ROWTYPE; settings commerce_payment_settings%ROWTYPE; result jsonb; new_id uuid;
BEGIN
 SELECT * INTO cart FROM commerce_guest_carts WHERE id=requested_cart AND token_hash=owner_hash FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cart not found' USING ERRCODE='P0002'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('commerce-orders:'||cart.store_id::text));
 IF EXISTS(SELECT 1 FROM commerce_orders WHERE cart_id=cart.id) THEN
  RETURN commerce_checkout_before_pix(requested_cart,owner_hash,expected_version,payload_hash,delivery_mode,expected_profile,expected_profile_updated);
 END IF;
 SELECT * INTO settings FROM commerce_payment_settings WHERE store_id=cart.store_id FOR SHARE;
 IF payment_version IS NULL OR payment_version<>coalesce(settings.version,0) THEN RAISE EXCEPTION 'Payment settings changed' USING ERRCODE='40001'; END IF;
 IF chosen_method IS NULL OR chosen_method NOT IN('PIX','CARD_PRESENT') OR (chosen_method='PIX' AND NOT coalesce(settings.enabled,false)) THEN RAISE EXCEPTION 'Payment method unavailable' USING ERRCODE='22023'; END IF;
 result:=commerce_checkout_before_pix(requested_cart,owner_hash,expected_version,payload_hash,delivery_mode,expected_profile,expected_profile_updated);
 new_id:=(result->>'id')::uuid;
 IF delivery_mode='DELIVERY' AND EXISTS(SELECT 1 FROM commerce_orders WHERE id=new_id AND
  (coalesce(address->>'state','') !~ '^[A-Z]{2}$' OR (address->>'latitude')::numeric NOT BETWEEN -90 AND 90 OR (address->>'longitude')::numeric NOT BETWEEN -180 AND 180))
 THEN RAISE EXCEPTION 'Complete the delivery address' USING ERRCODE='22023'; END IF;
 IF chosen_method='PIX' AND (result->>'subtotalCents')::bigint+(CASE WHEN delivery_mode='DELIVERY' THEN coalesce(settings.delivery_fee_cents,0) ELSE 0 END)<=0 THEN RAISE EXCEPTION 'Pix amount must be positive' USING ERRCODE='22023'; END IF;
 UPDATE commerce_orders SET flow_version=2,payment_method=chosen_method,
  delivery_fee_cents=CASE WHEN delivery_mode='DELIVERY' THEN coalesce(settings.delivery_fee_cents,0) ELSE 0 END WHERE id=new_id;
 UPDATE commerce_order_events SET reason='Aguardando aprovação da loja. Nenhuma cobrança foi gerada.' WHERE order_id=new_id;
 RETURN commerce_order_read(new_id);
END $$;
REVOKE ALL ON FUNCTION commerce_checkout_for_approval(uuid,text,integer,text,text,uuid,timestamptz,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_checkout_for_approval(uuid,text,integer,text,text,uuid,timestamptz,integer,text) TO rastreia_runtime;

-- Private state writer: callers hold the store advisory lock and the order row lock.
-- Both bank confirmation and manager approval use the same cost/inventory rules.
CREATE FUNCTION commerce_apply_approved_state(requested_order uuid,next_status text,change_reason text,actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE ord commerce_orders%ROWTYPE; item record; balance commerce_inventory_balances%ROWTYPE; delta integer; previous_actor text;
BEGIN
 SELECT * INTO STRICT ord FROM commerce_orders WHERE id=requested_order FOR UPDATE;
 previous_actor:=current_setting('app.user_id',true);PERFORM set_config('app.user_id',actor::text,true);
 IF next_status='CONFIRMED' AND ord.status NOT IN('RECEIVED','WAITING_PAYMENT') THEN RAISE EXCEPTION 'Invalid confirmation'; END IF;
 IF next_status IN('CONFIRMED','CANCELLED') THEN
  FOR item IN SELECT * FROM commerce_order_items WHERE order_id=ord.id ORDER BY variant_id LOOP
   IF item.stocked THEN
    SELECT * INTO STRICT balance FROM commerce_inventory_balances WHERE variant_id=item.variant_id FOR UPDATE;
    delta:=CASE WHEN next_status='CONFIRMED' THEN -item.quantity WHEN next_status='CANCELLED' AND ord.status IN('CONFIRMED','READY_PICKUP') THEN item.quantity ELSE 0 END;
    IF next_status='CONFIRMED' THEN UPDATE commerce_order_items SET financial_unit_cost_cents=balance.average_cost_cents WHERE order_id=ord.id AND variant_id=item.variant_id; END IF;
    UPDATE commerce_inventory_balances SET on_hand=on_hand+delta,reserved=reserved-CASE WHEN ord.status IN('RECEIVED','WAITING_PAYMENT') THEN item.quantity ELSE 0 END,version=version+1,updated_at=now() WHERE variant_id=item.variant_id;
    IF delta<>0 THEN
     INSERT INTO commerce_inventory_movements(tenant_id,store_id,variant_id,kind,delta,before_quantity,after_quantity,reason,actor_user_id,unit_cost_cents,order_id)
     VALUES(ord.tenant_id,ord.store_id,item.variant_id,CASE WHEN delta<0 THEN 'EXIT' ELSE 'RETURN' END,delta,balance.on_hand,balance.on_hand+delta,'Pedido catálogo #'||ord.number||': '||next_status,actor,CASE WHEN delta<0 THEN balance.average_cost_cents ELSE item.financial_unit_cost_cents END,ord.id);
    END IF;
   ELSIF next_status='CONFIRMED' THEN
    UPDATE commerce_order_items SET financial_unit_cost_cents=(SELECT nullif(v.cost_cents,0) FROM commerce_variants v WHERE v.id=item.variant_id) WHERE order_id=ord.id AND variant_id=item.variant_id;
   END IF;
  END LOOP;
 END IF;
 UPDATE commerce_orders SET status=next_status,version=version+1,updated_at=now() WHERE id=ord.id;
 INSERT INTO commerce_order_events(order_id,status,reason,actor_user_id) VALUES(ord.id,next_status,change_reason,actor);
 IF next_status='CANCELLED' THEN UPDATE commerce_pix_payments SET refund_required=paid_at IS NOT NULL,status=CASE WHEN paid_at IS NULL AND status<>'REVIEW_REQUIRED' THEN 'EXPIRED' ELSE status END WHERE order_id=ord.id; END IF;
 PERFORM set_config('app.user_id',coalesce(previous_actor,''),true);
END $$;
REVOKE ALL ON FUNCTION commerce_apply_approved_state(uuid,text,text,uuid) FROM PUBLIC,rastreia_runtime;

ALTER FUNCTION commerce_order_transition(uuid,uuid,integer,text,text) RENAME TO commerce_order_transition_legacy;
REVOKE ALL ON FUNCTION commerce_order_transition_legacy(uuid,uuid,integer,text,text) FROM PUBLIC,rastreia_runtime;
CREATE FUNCTION commerce_order_transition(requested_order uuid,requested_store uuid,expected_version integer,next_status text,change_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE ord commerce_orders%ROWTYPE;
BEGIN
 IF NOT commerce_manage_store(requested_store) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('commerce-orders:'||requested_store::text));
 PERFORM commerce_expire_store_orders(requested_store);
 SELECT * INTO ord FROM commerce_orders WHERE id=requested_order AND store_id=requested_store AND tenant_id=current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE='P0002'; END IF;
 IF ord.flow_version=1 THEN RETURN commerce_order_transition_legacy(requested_order,requested_store,expected_version,next_status,change_reason); END IF;
 IF ord.status='EXPIRED' THEN RETURN commerce_order_read(ord.id); END IF;
 IF expected_version IS NULL OR expected_version<>ord.version THEN RAISE EXCEPTION 'Order changed' USING ERRCODE='40001'; END IF;
 IF next_status IS NULL OR NOT (
  (ord.status='RECEIVED' AND next_status IN('CONFIRMED','CANCELLED')) OR
  (ord.status='WAITING_PAYMENT' AND next_status='CANCELLED') OR
  (ord.status='CONFIRMED' AND ord.fulfillment='PICKUP' AND next_status IN('READY_PICKUP','CANCELLED')) OR
  (ord.status='READY_PICKUP' AND ord.fulfillment='PICKUP' AND next_status IN('COMPLETED','CANCELLED')) OR
  (ord.status='CONFIRMED' AND ord.delivery_id IS NULL AND next_status='CANCELLED'))
 THEN RAISE EXCEPTION 'Use the delivery operation for linked orders' USING ERRCODE='22023'; END IF;
 IF next_status='CANCELLED' AND (change_reason IS NULL OR length(trim(change_reason)) NOT BETWEEN 5 AND 500) THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='22023'; END IF;
 IF ord.status='RECEIVED' AND next_status='CONFIRMED' THEN
  UPDATE commerce_orders SET approved_by=current_user_id() WHERE id=ord.id;
  IF ord.payment_method='PIX' THEN
   UPDATE commerce_orders SET status='WAITING_PAYMENT',reservation_expires_at=now()+interval '15 minutes',version=version+1,updated_at=now() WHERE id=ord.id;
   INSERT INTO commerce_pix_payments(order_id,company_id,expires_at) SELECT o.id,s.company_id,o.reservation_expires_at FROM commerce_orders o JOIN stores s ON s.id=o.store_id WHERE o.id=ord.id;
   INSERT INTO commerce_order_events(order_id,status,reason,actor_user_id) VALUES(ord.id,'WAITING_PAYMENT','Loja aprovou. Pague o Pix em até 15 minutos para liberar o atendimento.',current_user_id());
   RETURN commerce_order_read(ord.id);
  END IF;
 END IF;
 PERFORM commerce_apply_approved_state(ord.id,next_status,CASE WHEN next_status='CONFIRMED' THEN 'Aprovado. Cartão a cobrar na maquininha na entrega ou retirada.' WHEN next_status='READY_PICKUP' THEN 'Pedido pronto para retirada na loja.' WHEN next_status='COMPLETED' THEN 'Retirada confirmada pela loja.' ELSE trim(change_reason) END,current_user_id());
 RETURN commerce_order_read(ord.id);
END $$;
REVOKE ALL ON FUNCTION commerce_order_transition(uuid,uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_order_transition(uuid,uuid,integer,text,text) TO rastreia_runtime;

ALTER FUNCTION commerce_pix_settle(uuid,bigint,text,timestamptz) RENAME TO commerce_pix_settle_before_approval;
REVOKE ALL ON FUNCTION commerce_pix_settle_before_approval(uuid,bigint,text,timestamptz) FROM PUBLIC,rastreia_runtime;
CREATE FUNCTION commerce_pix_settle(requested_order uuid,bank_cents bigint,bank_e2e text,bank_paid_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE ord commerce_orders%ROWTYPE;
BEGIN
 PERFORM commerce_pix_settle_before_approval(requested_order,bank_cents,bank_e2e,bank_paid_at);
 SELECT * INTO ord FROM commerce_orders WHERE id=requested_order FOR UPDATE;
 IF ord.flow_version=2 AND ord.status='RECEIVED' AND ord.approved_by IS NOT NULL AND EXISTS(SELECT 1 FROM commerce_pix_payments WHERE order_id=ord.id AND status='PAID') THEN
  PERFORM commerce_apply_approved_state(ord.id,'CONFIRMED','Pix confirmado pelo banco. Atendimento liberado automaticamente.',ord.approved_by);
 END IF;
END $$;
REVOKE ALL ON FUNCTION commerce_pix_settle(uuid,bigint,text,timestamptz) FROM PUBLIC,rastreia_runtime;

CREATE OR REPLACE FUNCTION commerce_expire_store_orders(requested_store uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE ord record; item record; expired integer:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('commerce-orders:'||requested_store::text));
 FOR ord IN SELECT * FROM commerce_orders WHERE store_id=requested_store AND reservation_expires_at<=now()
 AND (status='WAITING_PAYMENT' OR (status='RECEIVED' AND (flow_version=2 OR payment_method='ARRANGE'))) ORDER BY id FOR UPDATE LOOP
  FOR item IN SELECT * FROM commerce_order_items WHERE order_id=ord.id AND stocked ORDER BY variant_id LOOP
   UPDATE commerce_inventory_balances SET reserved=reserved-item.quantity,version=version+1,updated_at=now() WHERE variant_id=item.variant_id;
  END LOOP;
  UPDATE commerce_orders SET status='EXPIRED',version=version+1,updated_at=now() WHERE id=ord.id;
  UPDATE commerce_pix_payments SET status=CASE WHEN status='REVIEW_REQUIRED' THEN status ELSE 'EXPIRED' END WHERE order_id=ord.id AND paid_at IS NULL;
  INSERT INTO commerce_order_events(order_id,status,reason) VALUES(ord.id,'EXPIRED',CASE WHEN ord.status='WAITING_PAYMENT' THEN 'Prazo do Pix encerrado. Não pague este código.' ELSE 'Prazo de aprovação da loja encerrado.' END);
  expired:=expired+1;
 END LOOP;
 RETURN expired;
END $$;
