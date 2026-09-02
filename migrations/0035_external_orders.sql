SET LOCAL search_path TO rastreia, public;

CREATE TABLE integration_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 company_id uuid NOT NULL, store_id uuid NOT NULL, provider text NOT NULL CHECK(provider='IFOOD'),
 mode text NOT NULL CHECK(mode IN ('mock','sandbox','production')),
 merchant_id uuid NOT NULL, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONNECTED','ERROR','DISABLED')),
 enabled boolean NOT NULL DEFAULT false, auto_import_orders boolean NOT NULL DEFAULT true,
 auto_create_delivery boolean NOT NULL DEFAULT true, events_mode text NOT NULL CHECK(events_mode IN ('polling','webhook')),
 delivery_dispatch_mode text NOT NULL DEFAULT 'MANUAL' CHECK(delivery_dispatch_mode IN ('IMMEDIATE','BEFORE_READY_TIME','MANUAL')),
 delivery_dispatch_minutes_before integer NOT NULL DEFAULT 15 CHECK(delivery_dispatch_minutes_before BETWEEN 0 AND 120),
 last_event_at timestamptz, last_success_at timestamptz, last_error_at timestamptz, last_error_message text,
 configured_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tenant_id), UNIQUE(provider,mode,merchant_id), UNIQUE(store_id,provider,mode),
 FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id), FOREIGN KEY(company_id,tenant_id) REFERENCES companies(id,tenant_id)
);
CREATE TRIGGER integration_company BEFORE INSERT OR UPDATE ON integration_connections FOR EACH ROW EXECUTE PROCEDURE derive_operation_company();

CREATE TABLE integration_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), integration_id uuid REFERENCES integration_connections(id),
 provider text NOT NULL DEFAULT 'IFOOD', mode text NOT NULL, external_event_id text NOT NULL,
 merchant_id uuid NOT NULL, external_order_id uuid NOT NULL, event_code text NOT NULL, event_full_code text NOT NULL,
 payload_encrypted text NOT NULL, status text NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','PROCESSING','PROCESSED','IGNORED','ERROR')),
 attempts integer NOT NULL DEFAULT 0, last_error text, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 event_created_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
 UNIQUE(provider,external_event_id)
);
CREATE INDEX integration_events_pending ON integration_events(next_attempt_at) WHERE status IN ('RECEIVED','ERROR');

CREATE TABLE external_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), company_id uuid NOT NULL, store_id uuid NOT NULL,
 integration_id uuid NOT NULL, provider text NOT NULL DEFAULT 'IFOOD', external_order_id uuid NOT NULL,
 external_display_id text, external_status text NOT NULL, external_status_at timestamptz NOT NULL,
 delivery_id uuid UNIQUE, own_delivery boolean NOT NULL, payload_encrypted text NOT NULL,
 import_state text NOT NULL DEFAULT 'IMPORTED', ready_at timestamptz, dispatch_due_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(integration_id,external_order_id), UNIQUE(id,tenant_id),
 FOREIGN KEY(integration_id,tenant_id) REFERENCES integration_connections(id,tenant_id),
 FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id), FOREIGN KEY(company_id,tenant_id) REFERENCES companies(id,tenant_id),
 FOREIGN KEY(delivery_id,tenant_id) REFERENCES deliveries(id,tenant_id)
);
CREATE TRIGGER external_order_company BEFORE INSERT OR UPDATE ON external_orders FOR EACH ROW EXECUTE PROCEDURE derive_operation_company();

CREATE TABLE integration_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_order_id uuid NOT NULL REFERENCES external_orders(id),
 operation text NOT NULL CHECK(operation IN ('CONFIRM','PREPARE','DISPATCH','CANCEL')),
 status text NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','SENDING','REQUEST_SENT','CONFIRMED','ERROR','UNCERTAIN')),
 payload jsonb NOT NULL DEFAULT '{}', attempts integer NOT NULL DEFAULT 0, last_error text,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, confirmed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(external_order_id,operation)
);

ALTER TABLE deliveries ADD COLUMN origin text NOT NULL DEFAULT 'MANUAL', ADD COLUMN external_order_id uuid;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_external_order_fk FOREIGN KEY(external_order_id,tenant_id) REFERENCES external_orders(id,tenant_id);
CREATE UNIQUE INDEX deliveries_external_order_unique ON deliveries(external_order_id) WHERE external_order_id IS NOT NULL;

CREATE FUNCTION integration_in_scope(requested_store uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT store_in_scope(requested_store) AND EXISTS(SELECT 1 FROM tenant_users m JOIN stores s ON s.tenant_id=m.tenant_id
 WHERE s.id=requested_store AND m.user_id=current_user_id() AND m.status='ACTIVE' AND m.role IN ('TENANT_MANAGER','STORE_OPERATOR'))
$$;
REVOKE ALL ON FUNCTION integration_in_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration_in_scope(uuid) TO rastreia_runtime;
ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY integrations_scope ON integration_connections USING(tenant_id=current_tenant_id() AND integration_in_scope(store_id)) WITH CHECK(tenant_id=current_tenant_id() AND integration_in_scope(store_id));
ALTER TABLE external_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY external_orders_scope ON external_orders USING(tenant_id=current_tenant_id() AND integration_in_scope(store_id)) WITH CHECK(tenant_id=current_tenant_id() AND integration_in_scope(store_id));
ALTER TABLE integration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_events FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_events_scope ON integration_events USING(EXISTS(SELECT 1 FROM integration_connections c WHERE c.id=integration_id)) WITH CHECK(EXISTS(SELECT 1 FROM integration_connections c WHERE c.id=integration_id));
ALTER TABLE integration_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_commands_scope ON integration_commands USING(EXISTS(SELECT 1 FROM external_orders o WHERE o.id=external_order_id)) WITH CHECK(EXISTS(SELECT 1 FROM external_orders o WHERE o.id=external_order_id));
GRANT SELECT,INSERT,UPDATE ON integration_connections,external_orders,integration_events,integration_commands TO rastreia_runtime;

-- Captures BOTH individual deliveries and route batches in the same transaction.
CREATE FUNCTION queue_external_dispatch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
BEGIN
 IF NEW.status='IN_ROUTE' AND OLD.status IS DISTINCT FROM NEW.status AND NEW.external_order_id IS NOT NULL THEN
  INSERT INTO integration_commands(external_order_id,operation)
   SELECT o.id,'DISPATCH' FROM external_orders o WHERE o.id=NEW.external_order_id AND o.delivery_id=NEW.id
    AND o.tenant_id=NEW.tenant_id AND o.store_id=NEW.store_id AND o.own_delivery AND o.external_status NOT IN ('CANCELLED','CONCLUDED')
   ON CONFLICT(external_order_id,operation) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION queue_external_dispatch() FROM PUBLIC;
CREATE TRIGGER delivery_external_dispatch AFTER UPDATE OF status ON deliveries FOR EACH ROW EXECUTE PROCEDURE queue_external_dispatch();
