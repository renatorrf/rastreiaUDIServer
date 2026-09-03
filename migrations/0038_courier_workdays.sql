SET LOCAL search_path TO rastreia, public;

ALTER TABLE stores ADD COLUMN opening_time time;
ALTER TABLE stores ADD COLUMN closing_time time;
ALTER TABLE stores ADD COLUMN operating_weekdays integer[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6];
ALTER TABLE stores ADD CONSTRAINT stores_working_hours_check CHECK (
  (opening_time IS NULL AND closing_time IS NULL) OR
  (opening_time IS NOT NULL AND closing_time IS NOT NULL AND opening_time <> closing_time));
ALTER TABLE stores ADD CONSTRAINT stores_weekdays_check CHECK (
  operating_weekdays <@ ARRAY[0,1,2,3,4,5,6] AND cardinality(operating_weekdays) BETWEEN 1 AND 7);

CREATE TABLE courier_workdays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  store_id uuid NOT NULL,
  courier_profile_id uuid NOT NULL REFERENCES courier_profiles(id),
  service_date date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','DECLINED','CHECKED_IN','COMPLETED','EXPIRED')),
  confirmed_at timestamptz,
  checkin_at timestamptz,
  checkout_at timestamptz,
  reminder_queued_at timestamptz,
  location_consent_at timestamptz,
  latitude double precision,
  longitude double precision,
  accuracy double precision,
  speed double precision,
  heading double precision,
  captured_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, tenant_id),
  UNIQUE(store_id, courier_profile_id, service_date),
  FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id),
  CHECK(ends_at > starts_at),
  CHECK(status <> 'CHECKED_IN' OR (checkin_at IS NOT NULL AND location_consent_at IS NOT NULL))
);
-- A courier may have links to many stores, but only one active check-in globally.
CREATE UNIQUE INDEX courier_workdays_one_active ON courier_workdays(courier_profile_id) WHERE status='CHECKED_IN';
CREATE INDEX courier_workdays_due ON courier_workdays(starts_at) WHERE status='PENDING' AND reminder_queued_at IS NULL;

CREATE TABLE courier_workday_tracking_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  workday_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash char(64) NOT NULL UNIQUE,
  platform text NOT NULL CHECK(platform IN ('android','ios')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workday_id,tenant_id) REFERENCES courier_workdays(id,tenant_id)
);
CREATE UNIQUE INDEX courier_workday_tracking_one_active ON courier_workday_tracking_sessions(workday_id) WHERE revoked_at IS NULL;

CREATE TABLE courier_workday_points (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  workday_id uuid NOT NULL,
  event_id uuid NOT NULL,
  latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  accuracy double precision NOT NULL CHECK(accuracy > 0 AND accuracy <= 1000),
  captured_at timestamptz NOT NULL,
  FOREIGN KEY(workday_id,tenant_id) REFERENCES courier_workdays(id,tenant_id),
  UNIQUE(workday_id,event_id)
);
CREATE INDEX courier_workday_points_retention ON courier_workday_points(captured_at);

ALTER TABLE courier_workdays ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_workdays FORCE ROW LEVEL SECURITY;
CREATE POLICY courier_workdays_scope ON courier_workdays USING (
  tenant_id=current_tenant_id() AND store_in_scope(store_id) AND (
    EXISTS(SELECT 1 FROM courier_profiles p WHERE p.id=courier_profile_id AND p.user_id=current_user_id())
    OR EXISTS(SELECT 1 FROM tenant_users u WHERE u.tenant_id=current_tenant_id() AND u.user_id=current_user_id()
      AND u.role IN ('TENANT_MANAGER','STORE_OPERATOR') AND u.status='ACTIVE')));
CREATE POLICY courier_workdays_master_read ON courier_workdays FOR SELECT USING(is_master());
ALTER TABLE courier_workday_tracking_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_workday_tracking_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY courier_workday_tracking_owner ON courier_workday_tracking_sessions USING (
  tenant_id=current_tenant_id() AND user_id=current_user_id()
  AND EXISTS(SELECT 1 FROM courier_workdays d WHERE d.id=workday_id));
CREATE POLICY courier_workday_tracking_lookup ON courier_workday_tracking_sessions FOR SELECT USING (
  token_hash=NULLIF(current_setting('app.workday_tracking_hash',true),''));
ALTER TABLE courier_workday_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_workday_points FORCE ROW LEVEL SECURITY;
CREATE POLICY courier_workday_points_scope ON courier_workday_points USING (
  tenant_id=current_tenant_id() AND EXISTS(SELECT 1 FROM courier_workdays d WHERE d.id=workday_id));
CREATE POLICY courier_workday_points_master_read ON courier_workday_points FOR SELECT USING(is_master());
GRANT SELECT,INSERT,UPDATE ON courier_workdays,courier_workday_tracking_sessions,courier_workday_points TO rastreia_runtime;
GRANT USAGE,SELECT ON SEQUENCE courier_workday_points_id_seq TO rastreia_runtime;

-- Store edits reset only future, unstarted confirmations. A checked-in day's
-- authorization deadline stays immutable; new hours apply to later journeys.
CREATE FUNCTION refresh_store_workdays() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path=rastreia,pg_temp AS $$
BEGIN
  IF NEW.opening_time IS NOT DISTINCT FROM OLD.opening_time AND NEW.closing_time IS NOT DISTINCT FROM OLD.closing_time
     AND NEW.operating_weekdays IS NOT DISTINCT FROM OLD.operating_weekdays THEN RETURN NEW; END IF;
  UPDATE courier_workdays day SET
    starts_at=COALESCE((day.service_date+NEW.opening_time) AT TIME ZONE tenant.timezone,day.starts_at),
    ends_at=COALESCE((day.service_date+NEW.closing_time+CASE WHEN NEW.closing_time<NEW.opening_time THEN interval '1 day' ELSE interval '0' END) AT TIME ZONE tenant.timezone,day.ends_at),
    status=CASE WHEN NEW.opening_time IS NULL OR NOT extract(dow FROM day.service_date)::int=ANY(NEW.operating_weekdays) THEN 'EXPIRED' ELSE 'PENDING' END,
    confirmed_at=NULL,reminder_queued_at=NULL,version=day.version+1,updated_at=now()
    FROM tenants tenant WHERE day.store_id=NEW.id AND tenant.id=day.tenant_id AND day.starts_at>now()
      AND day.status IN ('PENDING','CONFIRMED','DECLINED','EXPIRED');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION refresh_store_workdays() FROM PUBLIC;
CREATE TRIGGER stores_refresh_workdays AFTER UPDATE OF opening_time,closing_time,operating_weekdays ON stores
  FOR EACH ROW EXECUTE PROCEDURE refresh_store_workdays();
