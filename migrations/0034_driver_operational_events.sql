SET LOCAL search_path TO rastreia, public;

-- Separate from incidents/returns: these records never transition a delivery.
CREATE TABLE driver_operational_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  company_id uuid NOT NULL,
  store_id uuid NOT NULL,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id),
  delivery_id uuid,
  batch_id uuid,
  current_delivery_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('FLAT_TIRE','MECHANICAL_PROBLEM','ACCIDENT','HEAVY_TRAFFIC','ROAD_BLOCKED','POLICE_CHECK','ADDRESS_PROBLEM','CUSTOMER_NOT_FOUND','CUSTOMER_NOT_RESPONDING','PARKING_DIFFICULTY','WAITING_AT_GATE','ORDER_DAMAGED','EMERGENCY_STOP','OTHER')),
  scope text NOT NULL CHECK (scope IN ('DRIVER','BATCH','DELIVERY')),
  severity text NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','CANCELLED')),
  description text CHECK (char_length(description) BETWEEN 1 AND 500),
  latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude BETWEEN -180 AND 180),
  location_captured_at timestamptz,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_user_id uuid REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  customer_visibility text NOT NULL CHECK (customer_visibility IN ('INTERNAL','GENERIC','VISIBLE')),
  affects_eta boolean NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (store_id, tenant_id) REFERENCES stores(id, tenant_id),
  FOREIGN KEY (company_id, tenant_id) REFERENCES companies(id, tenant_id),
  FOREIGN KEY (delivery_id, tenant_id) REFERENCES deliveries(id, tenant_id),
  FOREIGN KEY (current_delivery_id, tenant_id) REFERENCES deliveries(id, tenant_id),
  FOREIGN KEY (batch_id, tenant_id) REFERENCES routes(id, tenant_id),
  CHECK ((scope='DELIVERY' AND delivery_id IS NOT NULL) OR (scope='BATCH' AND batch_id IS NOT NULL AND delivery_id IS NULL) OR (scope='DRIVER' AND delivery_id IS NULL)),
  CHECK ((latitude IS NULL AND longitude IS NULL AND location_captured_at IS NULL) OR (latitude IS NOT NULL AND longitude IS NOT NULL AND location_captured_at IS NOT NULL)),
  CHECK ((status='OPEN' AND resolved_at IS NULL AND resolved_by_user_id IS NULL) OR (status<>'OPEN' AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL)),
  CHECK (event_type<>'OTHER' OR char_length(btrim(description))>=3)
);
CREATE INDEX driver_events_store_open_idx ON driver_operational_events(tenant_id,store_id,severity,occurred_at DESC) WHERE status='OPEN';
CREATE INDEX driver_events_courier_idx ON driver_operational_events(tenant_id,courier_profile_id,occurred_at DESC);
CREATE INDEX driver_events_batch_idx ON driver_operational_events(batch_id,occurred_at);
CREATE INDEX driver_events_delivery_idx ON driver_operational_events(delivery_id,occurred_at);
CREATE UNIQUE INDEX driver_events_no_duplicate_open_idx ON driver_operational_events
 (tenant_id,courier_profile_id,event_type,scope,COALESCE(delivery_id,batch_id,current_delivery_id)) WHERE status='OPEN';
CREATE TRIGGER driver_events_company BEFORE INSERT ON driver_operational_events
 FOR EACH ROW EXECUTE PROCEDURE derive_operation_company();

CREATE TABLE driver_operational_event_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN','RESOLVED','CANCELLED')),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(event_id,tenant_id) REFERENCES driver_operational_events(id,tenant_id)
);
CREATE INDEX driver_event_history_idx ON driver_operational_event_history(event_id,occurred_at);

-- Snapshot affected deliveries; reassignment/replanning must not erase historical links.
CREATE TABLE driver_event_deliveries (
 tenant_id uuid NOT NULL, event_id uuid NOT NULL, delivery_id uuid NOT NULL,
 PRIMARY KEY(event_id,delivery_id),
 FOREIGN KEY(event_id,tenant_id) REFERENCES driver_operational_events(id,tenant_id),
 FOREIGN KEY(delivery_id,tenant_id) REFERENCES deliveries(id,tenant_id)
);

-- Token-based public tracking never receives SELECT access to internal events.
CREATE FUNCTION rastreia.driver_event_in_scope(requested_store uuid, requested_courier uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT is_master() OR (store_in_scope(requested_store) AND EXISTS(
  SELECT 1 FROM tenant_users membership JOIN stores store ON store.tenant_id=membership.tenant_id
  WHERE store.id=requested_store AND membership.user_id=current_user_id() AND membership.status='ACTIVE'
   AND (membership.role IN ('TENANT_MANAGER','STORE_OPERATOR') OR (membership.role='COURIER' AND EXISTS(
     SELECT 1 FROM courier_profiles profile WHERE profile.id=requested_courier AND profile.user_id=current_user_id())))))
$$;
REVOKE ALL ON FUNCTION rastreia.driver_event_in_scope(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.driver_event_in_scope(uuid,uuid) TO rastreia_runtime;
ALTER TABLE driver_operational_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_operational_events FORCE ROW LEVEL SECURITY;
CREATE POLICY driver_events_scope ON driver_operational_events
 USING ((tenant_id=current_tenant_id() OR is_master()) AND driver_event_in_scope(store_id,courier_profile_id))
 WITH CHECK ((tenant_id=current_tenant_id() OR is_master()) AND driver_event_in_scope(store_id,courier_profile_id));
ALTER TABLE driver_operational_event_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_operational_event_history FORCE ROW LEVEL SECURITY;
CREATE POLICY driver_event_history_scope ON driver_operational_event_history
 USING (EXISTS(SELECT 1 FROM driver_operational_events event WHERE event.id=event_id))
 WITH CHECK (EXISTS(SELECT 1 FROM driver_operational_events event WHERE event.id=event_id));
GRANT SELECT,INSERT,UPDATE ON driver_operational_events TO rastreia_runtime;
GRANT SELECT,INSERT ON driver_operational_event_history TO rastreia_runtime;
ALTER TABLE driver_event_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_event_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY driver_event_deliveries_scope ON driver_event_deliveries
 USING (EXISTS(SELECT 1 FROM driver_operational_events event WHERE event.id=event_id))
 WITH CHECK (EXISTS(SELECT 1 FROM driver_operational_events event WHERE event.id=event_id));
GRANT SELECT,INSERT ON driver_event_deliveries TO rastreia_runtime;

CREATE FUNCTION rastreia.guard_driver_event_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'status'-'resolved_at'-'resolved_by_user_id'-'updated_at') IS DISTINCT FROM
    (to_jsonb(OLD)-'status'-'resolved_at'-'resolved_by_user_id'-'updated_at') OR OLD.status<>'OPEN' THEN
   RAISE EXCEPTION 'Operational event history is immutable';
 END IF;
 NEW.updated_at:=now(); RETURN NEW;
END $$;
CREATE TRIGGER driver_events_immutable BEFORE UPDATE ON driver_operational_events
 FOR EACH ROW EXECUTE PROCEDURE guard_driver_event_history();

-- Deliberately projected allowlist: never return notes, type, driver, location or internal IDs.
CREATE FUNCTION rastreia.public_driver_event_notices(requested_delivery uuid)
 RETURNS TABLE(status text,message text,occurred_at timestamptz,resolved_at timestamptz,affects_eta boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT event.status,
  CASE WHEN event.status='OPEN' THEN 'Houve um imprevisto durante a entrega. A previsão poderá sofrer alteração.'
    ELSE 'O imprevisto informado foi encerrado.' END,
  event.occurred_at,event.resolved_at,event.affects_eta AND event.status='OPEN'
 FROM driver_operational_events event JOIN deliveries delivery ON delivery.id=requested_delivery
 WHERE event.tenant_id=delivery.tenant_id AND event.customer_visibility IN ('GENERIC','VISIBLE')
  AND EXISTS(SELECT 1 FROM driver_event_deliveries affected WHERE affected.event_id=event.id AND affected.delivery_id=delivery.id)
  AND EXISTS(SELECT 1 FROM tracking_tokens token WHERE token.delivery_id=delivery.id
   AND token.token_hash=NULLIF(current_setting('app.tracking_hash',true),'') AND token.revoked_at IS NULL AND token.expires_at>now())
 ORDER BY event.occurred_at DESC LIMIT 50
$$;
REVOKE ALL ON FUNCTION rastreia.public_driver_event_notices(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.public_driver_event_notices(uuid) TO rastreia_runtime;
