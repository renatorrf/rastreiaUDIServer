-- Gerencial: competência na conclusão; caixa somente na baixa explícita.
SET LOCAL search_path=rastreia,public;
ALTER TABLE commerce_inventory_balances ADD COLUMN average_cost_cents numeric(20,6) CHECK(average_cost_cents>=0);
ALTER TABLE commerce_inventory_movements ADD COLUMN unit_cost_cents numeric(20,6) CHECK(unit_cost_cents>=0);
ALTER TABLE commerce_inventory_movements ADD COLUMN order_id uuid REFERENCES commerce_orders(id);
ALTER TABLE commerce_order_items ADD COLUMN financial_unit_cost_cents numeric(20,6) CHECK(financial_unit_cost_cents>=0);
-- No grants on item costs: customer-visible order projections stay unchanged.

CREATE TABLE commerce_finance_categories(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 name text NOT NULL CHECK(char_length(trim(name)) BETWEEN 2 AND 100),
 direction text NOT NULL CHECK(direction IN ('IN','OUT')),
 dre_group text NOT NULL CHECK(dre_group IN ('REVENUE','DEDUCTIONS','COGS','VARIABLE','FIXED','DEPRECIATION','FINANCIAL_IN','FINANCIAL_OUT','PROFIT_TAX','CASH_ONLY')),
 CHECK((direction='IN' AND dre_group IN ('REVENUE','FINANCIAL_IN','CASH_ONLY')) OR (direction='OUT' AND dre_group NOT IN ('REVENUE','FINANCIAL_IN'))),
 UNIQUE(id,tenant_id,store_id),UNIQUE(store_id,name),FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id)
);
CREATE TABLE commerce_finance_entries(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 category_id uuid,order_id uuid UNIQUE,description text NOT NULL CHECK(char_length(trim(description)) BETWEEN 3 AND 200),
 direction text NOT NULL CHECK(direction IN ('IN','OUT')),dre_group text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents>0 AND amount_cents<=1000000000000),
 competence_date date NOT NULL,due_date date NOT NULL,document text NOT NULL DEFAULT '' CHECK(char_length(document)<=120),
 version integer NOT NULL DEFAULT 1,cancelled_at timestamptz,cancel_reason text,
 created_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tenant_id,store_id),FOREIGN KEY(category_id,tenant_id,store_id) REFERENCES commerce_finance_categories(id,tenant_id,store_id),
 FOREIGN KEY(order_id,tenant_id,store_id) REFERENCES commerce_orders(id,tenant_id,store_id),FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id)
);
CREATE TABLE commerce_finance_settlements(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,entry_id uuid NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents>0),paid_date date NOT NULL,method text NOT NULL CHECK(method IN ('PIX','CASH','CARD','TRANSFER','OTHER')),
 note text NOT NULL DEFAULT '' CHECK(char_length(note)<=500),reversed_date date,reverse_reason text,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(reversed_date IS NULL OR (reversed_date>=paid_date AND char_length(trim(reverse_reason)) BETWEEN 5 AND 500)),
 FOREIGN KEY(entry_id,tenant_id,store_id) REFERENCES commerce_finance_entries(id,tenant_id,store_id)
);
CREATE TABLE commerce_finance_sales(
 order_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,store_id uuid NOT NULL,recognized_date date NOT NULL,
 revenue_cents bigint NOT NULL CHECK(revenue_cents>=0),known_cost_cents bigint NOT NULL CHECK(known_cost_cents>=0),
 unknown_cost_items integer NOT NULL CHECK(unknown_cost_items>=0),legacy boolean NOT NULL DEFAULT false,
 FOREIGN KEY(order_id,tenant_id,store_id) REFERENCES commerce_orders(id,tenant_id,store_id)
);
CREATE INDEX commerce_finance_entries_period ON commerce_finance_entries(store_id,competence_date);
CREATE INDEX commerce_finance_entries_due ON commerce_finance_entries(store_id,due_date);
CREATE INDEX commerce_finance_settlements_entry ON commerce_finance_settlements(entry_id);
CREATE INDEX commerce_finance_settlements_period ON commerce_finance_settlements(store_id,paid_date);
CREATE INDEX commerce_finance_sales_period ON commerce_finance_sales(store_id,recognized_date);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['commerce_finance_categories','commerce_finance_entries','commerce_finance_settlements','commerce_finance_sales'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY manager_scope ON %I USING (tenant_id=current_tenant_id() AND commerce_manage_store(store_id)) WITH CHECK (tenant_id=current_tenant_id() AND commerce_manage_store(store_id))',tab);
  EXECUTE format('GRANT SELECT ON %I TO rastreia_runtime',tab);
 END LOOP;
END $$;
GRANT INSERT ON commerce_finance_categories,commerce_finance_entries,commerce_finance_settlements TO rastreia_runtime;
GRANT UPDATE(version,cancelled_at,cancel_reason) ON commerce_finance_entries TO rastreia_runtime;
GRANT UPDATE(reversed_date,reverse_reason) ON commerce_finance_settlements TO rastreia_runtime;

-- Protect snapshots/classification even against direct SQL with the runtime role.
CREATE FUNCTION commerce_finance_entry_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=rastreia,public,pg_temp AS $$
DECLARE cat commerce_finance_categories%ROWTYPE;
BEGIN
 IF NEW.category_id IS NOT NULL THEN
  SELECT * INTO cat FROM commerce_finance_categories WHERE id=NEW.category_id AND store_id=NEW.store_id AND tenant_id=NEW.tenant_id;
  IF NOT FOUND OR NEW.order_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid finance category' USING ERRCODE='23514'; END IF;
  NEW.direction:=cat.direction;NEW.dre_group:=cat.dre_group;
 ELSIF current_user='rastreia_runtime' THEN RAISE EXCEPTION 'Automatic entry is protected' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_finance_entry_guard BEFORE INSERT ON commerce_finance_entries FOR EACH ROW EXECUTE PROCEDURE commerce_finance_entry_guard();

-- Serialize financial mutations on the parent entry, including direct runtime SQL.
CREATE FUNCTION commerce_finance_settlement_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=rastreia,public,pg_temp AS $$
DECLARE entry commerce_finance_entries%ROWTYPE; paid bigint; day date:=(now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
 SELECT * INTO entry FROM commerce_finance_entries WHERE id=NEW.entry_id AND store_id=NEW.store_id AND tenant_id=NEW.tenant_id FOR UPDATE;
 IF NOT FOUND OR entry.cancelled_at IS NOT NULL OR entry.dre_group IN ('DEPRECIATION','COGS') THEN RAISE EXCEPTION 'Entry unavailable for settlement' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT coalesce(sum(amount_cents),0) INTO paid FROM commerce_finance_settlements WHERE entry_id=entry.id AND reversed_date IS NULL;
  IF NEW.amount_cents>entry.amount_cents-paid OR NEW.paid_date>day OR NEW.reversed_date IS NOT NULL THEN RAISE EXCEPTION 'Invalid settlement amount or date' USING ERRCODE='23514'; END IF;
  NEW.created_by:=current_user_id();
 ELSE
  IF OLD.reversed_date IS NOT NULL OR NEW.reversed_date IS NULL OR NEW.reversed_date>day OR NEW.reversed_date<NEW.paid_date OR NEW.reverse_reason IS NULL
  THEN RAISE EXCEPTION 'Invalid or repeated reversal' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_finance_settlement_guard BEFORE INSERT OR UPDATE ON commerce_finance_settlements FOR EACH ROW EXECUTE PROCEDURE commerce_finance_settlement_guard();
CREATE FUNCTION commerce_finance_cancel_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=rastreia,public,pg_temp AS $$
BEGIN
 IF OLD.cancelled_at IS DISTINCT FROM NEW.cancelled_at OR OLD.cancel_reason IS DISTINCT FROM NEW.cancel_reason THEN
  IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL OR NEW.order_id IS NOT NULL OR NEW.cancel_reason IS NULL OR char_length(trim(NEW.cancel_reason)) NOT BETWEEN 5 AND 500
  OR EXISTS(SELECT 1 FROM commerce_finance_settlements WHERE entry_id=NEW.id AND reversed_date IS NULL)
  THEN RAISE EXCEPTION 'Entry cannot be cancelled' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_finance_cancel_guard BEFORE UPDATE ON commerce_finance_entries FOR EACH ROW EXECUTE PROCEDURE commerce_finance_cancel_guard();
REVOKE ALL ON FUNCTION commerce_finance_entry_guard(),commerce_finance_settlement_guard(),commerce_finance_cancel_guard() FROM PUBLIC;

-- Every movement (including imports/legacy clients) updates average cost. Unknown entries
-- contaminate an unknown balance instead of silently valuing it at zero or catalog price.
CREATE FUNCTION commerce_finance_stock_movement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE average numeric;
BEGIN
 SELECT average_cost_cents INTO average FROM commerce_inventory_balances WHERE variant_id=NEW.variant_id FOR UPDATE;
 IF NEW.delta<0 THEN NEW.unit_cost_cents:=average;
 ELSE
  UPDATE commerce_inventory_balances SET average_cost_cents=CASE
   WHEN NEW.unit_cost_cents IS NULL OR (NEW.before_quantity>0 AND average IS NULL) THEN NULL
   ELSE (coalesce(average,0)*NEW.before_quantity+NEW.unit_cost_cents*NEW.delta)/NEW.after_quantity END WHERE variant_id=NEW.variant_id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION commerce_finance_stock_movement() FROM PUBLIC;
CREATE TRIGGER commerce_finance_stock_movement BEFORE INSERT ON commerce_inventory_movements FOR EACH ROW EXECUTE PROCEDURE commerce_finance_stock_movement();

CREATE FUNCTION commerce_adjust_inventory_costed(requested_variant uuid,requested_store uuid,expected_version integer,quantity_delta integer,movement_kind text,movement_reason text,entry_unit_cost numeric)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE balance commerce_inventory_balances%ROWTYPE; movement_id uuid;
BEGIN
 IF NOT commerce_manage_store(requested_store) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 IF expected_version IS NULL OR expected_version<1 OR quantity_delta IS NULL OR movement_kind IS NULL OR movement_reason IS NULL
 OR quantity_delta=0 OR abs(quantity_delta::bigint)>1000000 OR char_length(trim(movement_reason)) NOT BETWEEN 5 AND 500
 OR movement_kind NOT IN ('ENTRY','EXIT','LOSS','CONSUMPTION','RETURN','ADJUSTMENT')
 OR (movement_kind IN ('ENTRY','RETURN') AND quantity_delta<0) OR (movement_kind IN ('EXIT','LOSS','CONSUMPTION') AND quantity_delta>0)
 OR (entry_unit_cost IS NOT NULL AND (entry_unit_cost<0 OR entry_unit_cost>100000000 OR entry_unit_cost<>trunc(entry_unit_cost)))
 THEN RAISE EXCEPTION 'Invalid movement' USING ERRCODE='22023'; END IF;
 SELECT * INTO balance FROM commerce_inventory_balances WHERE variant_id=requested_variant AND store_id=requested_store AND tenant_id=current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Variant not found' USING ERRCODE='P0002'; END IF;
 IF balance.version<>expected_version THEN RAISE EXCEPTION 'Stock version conflict' USING ERRCODE='40001'; END IF;
 IF balance.on_hand::bigint+quantity_delta<balance.reserved OR balance.on_hand::bigint+quantity_delta>1000000 THEN RAISE EXCEPTION 'Insufficient stock' USING ERRCODE='23514'; END IF;
 UPDATE commerce_inventory_balances SET on_hand=on_hand+quantity_delta,version=version+1,updated_at=now() WHERE variant_id=requested_variant;
 INSERT INTO commerce_inventory_movements(tenant_id,store_id,variant_id,kind,delta,before_quantity,after_quantity,reason,actor_user_id,unit_cost_cents)
 VALUES(balance.tenant_id,balance.store_id,requested_variant,movement_kind,quantity_delta,balance.on_hand,balance.on_hand+quantity_delta,trim(movement_reason),current_user_id(),entry_unit_cost) RETURNING id INTO movement_id;
 RETURN movement_id;
END $$;
REVOKE ALL ON FUNCTION commerce_adjust_inventory_costed(uuid,uuid,integer,integer,text,text,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_adjust_inventory_costed(uuid,uuid,integer,integer,text,text,numeric) TO rastreia_runtime;

CREATE FUNCTION commerce_finance_initialize_cost(requested_variant uuid,requested_store uuid,expected_version integer,unit_cost integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE balance commerce_inventory_balances%ROWTYPE;
BEGIN
 IF NOT commerce_manage_store(requested_store) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 IF unit_cost IS NULL OR unit_cost<0 OR unit_cost>100000000 THEN RAISE EXCEPTION 'Invalid cost' USING ERRCODE='22023'; END IF;
 SELECT * INTO balance FROM commerce_inventory_balances WHERE variant_id=requested_variant AND store_id=requested_store AND tenant_id=current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 IF expected_version IS NULL OR balance.version<>expected_version THEN RAISE EXCEPTION 'Stock changed' USING ERRCODE='40001'; END IF;
 IF balance.average_cost_cents IS NOT NULL THEN RAISE EXCEPTION 'Cost already known' USING ERRCODE='23514'; END IF;
 UPDATE commerce_inventory_balances SET average_cost_cents=unit_cost,version=version+1,updated_at=now() WHERE variant_id=requested_variant;
END $$;
REVOKE ALL ON FUNCTION commerce_finance_initialize_cost(uuid,uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_finance_initialize_cost(uuid,uuid,integer,integer) TO rastreia_runtime;

CREATE OR REPLACE FUNCTION commerce_order_transition(requested_order uuid,requested_store uuid,expected_version integer,next_status text,change_reason text) RETURNS jsonb
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
 FOR item IN SELECT * FROM commerce_order_items WHERE order_id=ord.id ORDER BY variant_id LOOP
  IF item.stocked THEN
   SELECT * INTO balance FROM commerce_inventory_balances WHERE variant_id=item.variant_id FOR UPDATE;
   delta:=CASE WHEN next_status='CONFIRMED' THEN -item.quantity WHEN next_status='CANCELLED' AND ord.status='CONFIRMED' THEN item.quantity ELSE 0 END;
   IF next_status='CONFIRMED' THEN UPDATE commerce_order_items SET financial_unit_cost_cents=balance.average_cost_cents WHERE order_id=ord.id AND variant_id=item.variant_id; END IF;
   UPDATE commerce_inventory_balances SET on_hand=on_hand+delta,reserved=reserved-CASE WHEN ord.status='RECEIVED' THEN item.quantity ELSE 0 END,version=version+1,updated_at=now() WHERE variant_id=item.variant_id;
   IF delta<>0 THEN
    INSERT INTO commerce_inventory_movements(tenant_id,store_id,variant_id,kind,delta,before_quantity,after_quantity,reason,actor_user_id,unit_cost_cents,order_id)
    VALUES(ord.tenant_id,ord.store_id,item.variant_id,CASE WHEN delta<0 THEN 'EXIT' ELSE 'RETURN' END,delta,balance.on_hand,balance.on_hand+delta,'Pedido catálogo #'||ord.number||': '||next_status,current_user_id(),item.financial_unit_cost_cents,ord.id);
   END IF;
  ELSIF next_status='CONFIRMED' THEN
   UPDATE commerce_order_items SET financial_unit_cost_cents=(SELECT nullif(v.cost_cents,0) FROM commerce_variants v WHERE v.id=item.variant_id) WHERE order_id=ord.id AND variant_id=item.variant_id;
  END IF;
 END LOOP;
 UPDATE commerce_orders SET status=next_status,version=version+1,updated_at=now() WHERE id=ord.id;
 INSERT INTO commerce_order_events(order_id,status,reason,actor_user_id) VALUES(ord.id,next_status,coalesce(trim(change_reason),''),current_user_id());
 RETURN commerce_order_read(ord.id);
END $$;

CREATE FUNCTION commerce_finance_recognize_sale() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE day date:=(now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
 IF NEW.status='COMPLETED' AND OLD.status<>'COMPLETED' THEN
  INSERT INTO commerce_finance_sales(order_id,tenant_id,store_id,recognized_date,revenue_cents,known_cost_cents,unknown_cost_items)
  SELECT NEW.id,NEW.tenant_id,NEW.store_id,day,NEW.subtotal_cents,coalesce(round(sum(quantity*financial_unit_cost_cents)),0),count(*) FILTER(WHERE financial_unit_cost_cents IS NULL)
  FROM commerce_order_items WHERE order_id=NEW.id;
  IF NEW.subtotal_cents>0 THEN
   INSERT INTO commerce_finance_entries(tenant_id,store_id,order_id,description,direction,dre_group,amount_cents,competence_date,due_date,created_by)
   VALUES(NEW.tenant_id,NEW.store_id,NEW.id,'Pedido #'||NEW.number||' · '||left(NEW.customer_name,120),'IN','REVENUE',NEW.subtotal_cents,day,day,current_user_id());
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION commerce_finance_recognize_sale() FROM PUBLIC;
CREATE TRIGGER commerce_finance_sale AFTER UPDATE OF status ON commerce_orders FOR EACH ROW EXECUTE PROCEDURE commerce_finance_recognize_sale();
-- Historical results are visible, but never invent historical cost or unpaid receivables.
INSERT INTO commerce_finance_sales(order_id,tenant_id,store_id,recognized_date,revenue_cents,known_cost_cents,unknown_cost_items,legacy)
 SELECT o.id,o.tenant_id,o.store_id,(coalesce((SELECT min(e.created_at) FROM commerce_order_events e WHERE e.order_id=o.id AND e.status='COMPLETED'),o.updated_at) AT TIME ZONE 'America/Sao_Paulo')::date,
 o.subtotal_cents,0,(SELECT count(*) FROM commerce_order_items i WHERE i.order_id=o.id),true FROM commerce_orders o WHERE o.status='COMPLETED';
