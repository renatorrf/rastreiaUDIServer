SET LOCAL search_path TO rastreia, public;

CREATE TABLE billing_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), store_id uuid NOT NULL UNIQUE,
 legal_name text NOT NULL, trade_name text NOT NULL, tax_id_encrypted text NOT NULL, state_registration text, municipal_registration text,
 financial_email citext NOT NULL, financial_phone text, financial_contact text NOT NULL, billing_address jsonb NOT NULL,
 plan_code text NOT NULL, recurring_amount numeric(12,2) NOT NULL CHECK(recurring_amount>=0),
 additional_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK(additional_amount>=0),
 due_day integer NOT NULL CHECK(due_day BETWEEN 1 AND 31), starts_on date NOT NULL,
 periodicity text NOT NULL DEFAULT 'MONTHLY' CHECK(periodicity='MONTHLY'), preferred_payment_method text NOT NULL DEFAULT 'MANUAL',
 grace_days integer NOT NULL DEFAULT 0 CHECK(grace_days BETWEEN 0 AND 365), timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
 internal_notes text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id), UNIQUE(id,tenant_id)
);
CREATE TABLE invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),store_id uuid NOT NULL,
 period date NOT NULL CHECK(extract(day FROM period)=1), charge_type text NOT NULL DEFAULT 'SUBSCRIPTION', description text NOT NULL,
 due_date date NOT NULL, status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','ISSUED','OVERDUE','DELINQUENT','PAID','CANCELLED')),
 timezone text NOT NULL DEFAULT 'America/Sao_Paulo', version integer NOT NULL DEFAULT 1,
 delinquency_notified_at timestamptz, suspension_scheduled_at timestamptz, issued_at timestamptz, paid_at timestamptz,
 provider text, external_id text, processing_state text, idempotency_key text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id), UNIQUE(id,tenant_id), UNIQUE(store_id,period,charge_type)
);
CREATE INDEX invoices_due_idx ON invoices(status,due_date);
CREATE TABLE invoice_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),invoice_id uuid NOT NULL,
 description text NOT NULL,amount numeric(12,2) NOT NULL CHECK(amount<>0),
 created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(invoice_id,tenant_id) REFERENCES invoices(id,tenant_id)
);
CREATE TABLE invoice_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),invoice_id uuid NOT NULL,
 amount numeric(12,2) NOT NULL CHECK(amount>0),paid_at timestamptz NOT NULL,method text NOT NULL,
 source text NOT NULL DEFAULT 'MANUAL' CHECK(source='MANUAL'),reference text,provider text,external_id text,
 idempotency_key text NOT NULL UNIQUE,actor_platform_admin_id uuid NOT NULL REFERENCES platform_admins(id),
 reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(invoice_id,tenant_id) REFERENCES invoices(id,tenant_id)
);
CREATE TABLE invoice_status_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),invoice_id uuid NOT NULL,
 from_status text,to_status text NOT NULL,reason text NOT NULL,actor_platform_admin_id uuid REFERENCES platform_admins(id),
 created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(invoice_id,tenant_id) REFERENCES invoices(id,tenant_id)
);
CREATE TABLE billing_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),invoice_id uuid NOT NULL,
 recipient_user_id uuid NOT NULL REFERENCES users(id),kind text NOT NULL,channel text NOT NULL DEFAULT 'IN_APP',
 status text NOT NULL DEFAULT 'AVAILABLE',created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(invoice_id,recipient_user_id,kind),FOREIGN KEY(invoice_id,tenant_id) REFERENCES invoices(id,tenant_id)
);
CREATE TABLE unit_financial_holds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),store_id uuid NOT NULL UNIQUE,
 scheduled_at timestamptz,blocked_at timestamptz,released_at timestamptz,waiver_until timestamptz,
 reason text NOT NULL,actor_platform_admin_id uuid REFERENCES platform_admins(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id)
);

CREATE OR REPLACE FUNCTION rastreia.can_read_unit_billing(requested_store uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
 SELECT is_master() OR EXISTS(SELECT 1 FROM user_store_access access
 JOIN tenant_users membership ON membership.id=access.tenant_user_id
 WHERE access.store_id=requested_store AND membership.tenant_id=current_tenant_id()
 AND membership.user_id=current_user_id() AND membership.role='TENANT_MANAGER' AND membership.status='ACTIVE')
$$;
REVOKE ALL ON FUNCTION rastreia.can_read_unit_billing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.can_read_unit_billing(uuid) TO rastreia_runtime;

ALTER TABLE billing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_profiles_master ON billing_profiles USING(is_master()) WITH CHECK(is_master());
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY invoices_read ON invoices FOR SELECT USING(can_read_unit_billing(store_id));
CREATE POLICY invoices_insert ON invoices FOR INSERT WITH CHECK(is_master());
CREATE POLICY invoices_update ON invoices FOR UPDATE USING(is_master()) WITH CHECK(is_master());
ALTER TABLE unit_financial_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_financial_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY holds_read ON unit_financial_holds FOR SELECT USING(can_read_unit_billing(store_id));
CREATE POLICY holds_insert ON unit_financial_holds FOR INSERT WITH CHECK(is_master());
CREATE POLICY holds_update ON unit_financial_holds FOR UPDATE USING(is_master()) WITH CHECK(is_master());
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['invoice_items','invoice_payments','invoice_status_history','billing_notifications'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY billing_read ON %I FOR SELECT USING (EXISTS(SELECT 1 FROM invoices WHERE id=invoice_id))',table_name);
  EXECUTE format('CREATE POLICY billing_insert ON %I FOR INSERT WITH CHECK (is_master())',table_name);
 END LOOP;
END $$;
CREATE POLICY items_delete ON invoice_items FOR DELETE USING(is_master());
GRANT SELECT,INSERT,UPDATE ON billing_profiles,invoices,unit_financial_holds TO rastreia_runtime;
GRANT SELECT,INSERT ON invoice_items,invoice_payments,invoice_status_history,billing_notifications TO rastreia_runtime;
GRANT DELETE ON invoice_items TO rastreia_runtime;

CREATE OR REPLACE FUNCTION rastreia.unit_accepts_new_operations(requested_store uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM stores store JOIN tenants tenant ON tenant.id=store.tenant_id
  WHERE store.id=requested_store AND store.status='ACTIVE' AND tenant.status='ACTIVE')
 AND NOT EXISTS(SELECT 1 FROM unit_financial_holds WHERE store_id=requested_store AND blocked_at IS NOT NULL
  AND released_at IS NULL AND (waiver_until IS NULL OR waiver_until<=now()))
$$;
REVOKE ALL ON FUNCTION rastreia.unit_accepts_new_operations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.unit_accepts_new_operations(uuid) TO rastreia_runtime;

CREATE OR REPLACE FUNCTION rastreia.guard_new_unit_operation() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
DECLARE target uuid;
BEGIN
 target := NEW.store_id;
 -- Serialize creation with financial hold/payment updates on the same unit.
 PERFORM id FROM stores WHERE id=target FOR SHARE;
 IF NOT unit_accepts_new_operations(target) THEN
  RAISE EXCEPTION 'UNIT_UNAVAILABLE' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER deliveries_unit_available BEFORE INSERT ON deliveries FOR EACH ROW EXECUTE PROCEDURE guard_new_unit_operation();
CREATE TRIGGER offers_unit_available BEFORE INSERT ON delivery_offers FOR EACH ROW EXECUTE PROCEDURE guard_new_unit_operation();
CREATE TRIGGER slots_unit_available BEFORE INSERT ON shift_slots FOR EACH ROW EXECUTE PROCEDURE guard_new_unit_operation();
CREATE TRIGGER templates_unit_available BEFORE INSERT ON shift_templates FOR EACH ROW EXECUTE PROCEDURE guard_new_unit_operation();
CREATE OR REPLACE FUNCTION rastreia.guard_new_shift_start() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
DECLARE target uuid;
BEGIN
 IF NEW.status IN ('FILLED','ACTIVE') AND OLD.status IS DISTINCT FROM NEW.status THEN
  SELECT store_id INTO target FROM shift_slots WHERE id=NEW.slot_id;
  PERFORM id FROM stores WHERE id=target FOR SHARE;
  IF NOT unit_accepts_new_operations(target) THEN RAISE EXCEPTION 'UNIT_UNAVAILABLE' USING ERRCODE='P0001'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shift_start_unit_available BEFORE UPDATE ON shift_positions FOR EACH ROW EXECUTE PROCEDURE guard_new_shift_start();
