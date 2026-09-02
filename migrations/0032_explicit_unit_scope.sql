SET LOCAL search_path TO rastreia, public;
-- Internal legacy provisioning remains compatible; public registration always explicitly inserts NULL.
ALTER TABLE users ALTER COLUMN email_verified_at SET DEFAULT now();
-- Preserve trusted internal accounts created by the old API during the staged rollout.
UPDATE users SET email_verified_at=created_at WHERE email_verified_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM identity_actions action WHERE action.user_id=users.id)
 AND NOT EXISTS(SELECT 1 FROM courier_profiles p JOIN courier_service_preferences pref ON pref.courier_profile_id=p.id WHERE p.user_id=users.id);

CREATE OR REPLACE FUNCTION rastreia.store_in_scope(requested_store uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
 SELECT is_master() OR EXISTS(
  SELECT 1 FROM stores store JOIN tenants tenant ON tenant.id=store.tenant_id
  WHERE store.id=requested_store AND store.status='ACTIVE' AND tenant.status='ACTIVE'
  AND (
    EXISTS(SELECT 1 FROM tracking_tokens token JOIN deliveries delivery ON delivery.id=token.delivery_id
      WHERE token.token_hash=NULLIF(current_setting('app.tracking_hash',true),'') AND token.revoked_at IS NULL
      AND token.expires_at>now() AND delivery.store_id=store.id)
    OR (
      (NULLIF(current_setting('app.store_ids',true),'') IS NULL
        OR COALESCE(current_setting('app.store_ids',true),'[]')::jsonb ? store.id::text)
      AND EXISTS(SELECT 1 FROM tenant_users membership WHERE membership.tenant_id=store.tenant_id
       AND membership.user_id=current_user_id() AND membership.status='ACTIVE'
       AND (EXISTS(SELECT 1 FROM user_store_access access WHERE access.tenant_user_id=membership.id AND access.store_id=store.id)
        OR (membership.role='COURIER' AND EXISTS(SELECT 1 FROM courier_store_links link
          JOIN courier_profiles profile ON profile.id=link.courier_profile_id
          WHERE link.store_id=store.id AND profile.user_id=current_user_id() AND profile.status='ACTIVE' AND link.status='ACTIVE'))))
    )
  )
 )
$$;
REVOKE ALL ON FUNCTION rastreia.store_in_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.store_in_scope(uuid) TO rastreia_runtime;

-- PG 9.6 has no restrictive policies. Narrow the existing tenant policies, keeping the separate token policies intact.
DO $$ DECLARE spec record; policy record; condition text; BEGIN
 FOR spec IN SELECT * FROM (VALUES
  ('stores','id'),('deliveries','store_id'),('routes','store_id'),('shift_slots','store_id'),
  ('shift_templates','store_id'),('delivery_offers','store_id'),('courier_store_links','store_id'),('user_store_access','store_id'),
  ('incidents','store_id'),
  ('offer_financial_entries','store_id'),('offer_disputes','store_id'),
  ('offer_candidates','(SELECT store_id FROM delivery_offers WHERE id=offer_id)'),
  ('delivery_offer_events','(SELECT store_id FROM delivery_offers WHERE id=offer_id)'),
  ('offer_price_revisions','(SELECT store_id FROM delivery_offers WHERE id=offer_id)'),
  ('offer_dispute_evidence','(SELECT store_id FROM offer_disputes WHERE id=dispute_id)'),
  ('offer_dispute_events','(SELECT store_id FROM offer_disputes WHERE id=dispute_id)'),
  ('shift_confirmations','(SELECT slot.store_id FROM shift_positions position JOIN shift_slots slot ON slot.id=position.slot_id WHERE position.id=position_id)'),
  ('shift_change_requests','(SELECT slot.store_id FROM shift_positions position JOIN shift_slots slot ON slot.id=position.slot_id WHERE position.id=position_id)'),
  ('shift_searches','(SELECT slot.store_id FROM shift_positions position JOIN shift_slots slot ON slot.id=position.slot_id WHERE position.id=position_id)'),
  ('shift_search_waves','(SELECT slot.store_id FROM shift_searches search JOIN shift_positions position ON position.id=search.position_id JOIN shift_slots slot ON slot.id=position.slot_id WHERE search.id=search_id)'),
  ('shift_search_candidates','(SELECT slot.store_id FROM shift_searches search JOIN shift_positions position ON position.id=search.position_id JOIN shift_slots slot ON slot.id=position.slot_id WHERE search.id=search_id)'),
  ('delivery_status_history','(SELECT store_id FROM deliveries WHERE id=delivery_id)'),
  ('delivery_proofs','(SELECT store_id FROM deliveries WHERE id=delivery_id)'),
  ('message_deliveries','(SELECT store_id FROM deliveries WHERE id=delivery_id)'),
  ('route_stops','(SELECT store_id FROM routes WHERE id=route_id)'),
  ('route_events','(SELECT store_id FROM routes WHERE id=route_id)'),
  ('shift_positions','(SELECT store_id FROM shift_slots WHERE id=slot_id)'),
  ('shift_applications','(SELECT slot.store_id FROM shift_positions position JOIN shift_slots slot ON slot.id=position.slot_id WHERE position.id=position_id)'),
  ('shift_template_holders','(SELECT store_id FROM shift_templates WHERE id=template_id)'),
  ('incident_events','(SELECT store_id FROM incidents WHERE id=incident_id)'),
  ('incident_evidence','(SELECT store_id FROM incidents WHERE id=incident_id)'),
  ('courier_last_locations','(SELECT store_id FROM deliveries WHERE id=delivery_id)'),
  ('location_points','(SELECT store_id FROM deliveries WHERE id=delivery_id)')
 ) AS rules(table_name,store_expression) LOOP
  FOR policy IN SELECT polname,polcmd,pg_get_expr(polqual,polrelid) AS using_expr,pg_get_expr(polwithcheck,polrelid) AS check_expr
   FROM pg_policy WHERE polrelid=('rastreia.'||spec.table_name)::regclass AND polname NOT LIKE '%master%' LOOP
    condition := format('tenant_id = rastreia.current_tenant_id() AND rastreia.store_in_scope(%s)',spec.store_expression);
    IF policy.polcmd='*' THEN
      EXECUTE format('ALTER POLICY %I ON %I USING (%s) WITH CHECK (%s)',policy.polname,spec.table_name,condition,condition);
    ELSIF policy.polcmd='r' THEN
      EXECUTE format('ALTER POLICY %I ON %I USING ((%s) AND (%s))',policy.polname,spec.table_name,policy.using_expr,condition);
    END IF;
  END LOOP;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION rastreia.tenant_session_is_current(requested_tenant_id uuid,requested_user_id uuid,
 requested_role text,requested_store_ids uuid[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM tenants tenant JOIN tenant_users membership ON membership.tenant_id=tenant.id
  JOIN users account ON account.id=membership.user_id
  WHERE tenant.id=requested_tenant_id AND tenant.status='ACTIVE' AND account.id=requested_user_id
  AND membership.status='ACTIVE' AND account.status='ACTIVE' AND account.email_verified_at IS NOT NULL
  AND membership.role::text=requested_role AND COALESCE(array_length(requested_store_ids,1),0)>0
  AND NOT EXISTS(SELECT 1 FROM unnest(requested_store_ids) AS claimed(id)
    WHERE NOT EXISTS(SELECT 1 FROM stores store WHERE store.id=claimed.id AND store.tenant_id=tenant.id AND store.status='ACTIVE'
      AND (EXISTS(SELECT 1 FROM user_store_access access WHERE access.store_id=store.id AND access.tenant_user_id=membership.id)
      OR (membership.role='COURIER' AND EXISTS(SELECT 1 FROM courier_store_links link
        JOIN courier_profiles p ON p.id=link.courier_profile_id WHERE link.store_id=store.id
        AND link.status='ACTIVE' AND p.status='ACTIVE' AND p.user_id=requested_user_id)))))
 )
$$;

CREATE OR REPLACE FUNCTION rastreia.guard_master_unit_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user='rastreia_runtime' AND NOT rastreia.is_master() THEN
  RAISE EXCEPTION 'MASTER_REQUIRED' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stores_master_only BEFORE INSERT OR UPDATE ON stores FOR EACH ROW EXECUTE PROCEDURE guard_master_unit_write();

-- Membership status is tenant-wide: a unit manager must not change colleagues
-- who also belong to units outside the selected scope.
CREATE OR REPLACE FUNCTION rastreia.can_manage_scoped_person(target_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT is_master() OR (target_user<>current_user_id()
  AND EXISTS(SELECT 1 FROM tenant_users WHERE user_id=current_user_id() AND tenant_id=current_tenant_id()
    AND role='TENANT_MANAGER' AND status='ACTIVE')
  AND EXISTS(SELECT 1 FROM tenant_users member WHERE member.user_id=target_user AND member.tenant_id=current_tenant_id()
    AND member.role<>'TENANT_MANAGER'
    AND (EXISTS(SELECT 1 FROM user_store_access access WHERE access.tenant_user_id=member.id AND store_in_scope(access.store_id))
      OR EXISTS(SELECT 1 FROM courier_store_links link JOIN courier_profiles p ON p.id=link.courier_profile_id
        WHERE p.user_id=target_user AND link.tenant_id=member.tenant_id AND store_in_scope(link.store_id)))
    AND NOT EXISTS(SELECT 1 FROM user_store_access access WHERE access.tenant_user_id=member.id AND NOT store_in_scope(access.store_id))
    AND NOT EXISTS(SELECT 1 FROM courier_store_links link JOIN courier_profiles p ON p.id=link.courier_profile_id
      WHERE p.user_id=target_user AND link.tenant_id=member.tenant_id AND link.status<>'ENDED' AND NOT store_in_scope(link.store_id))))
$$;
REVOKE ALL ON FUNCTION rastreia.can_manage_scoped_person(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.can_manage_scoped_person(uuid) TO rastreia_runtime;

-- Reuse the existing tenant search pipeline without creating links or assignments.
-- Only existing active links receive the courier's explicitly authorized snapshot.
CREATE FUNCTION rastreia.sync_global_availability() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
BEGIN
 UPDATE courier_availability SET status='UNAVAILABLE',latitude=NULL,longitude=NULL,accuracy=NULL,available_until=NULL
  WHERE courier_profile_id=NEW.courier_profile_id;
 IF NEW.registration_status='APPROVED' AND NEW.availability_status='AVAILABLE' AND NEW.location_expires_at>now() THEN
  INSERT INTO courier_availability(tenant_id,courier_profile_id,status,latitude,longitude,accuracy,interest_radius_m,available_until,updated_by)
   SELECT DISTINCT member.tenant_id,p.id,'AVAILABLE'::courier_availability_status,NEW.latitude,NEW.longitude,NEW.accuracy,NEW.radius_m,NEW.location_expires_at,p.user_id
   FROM courier_profiles p JOIN tenant_users member ON member.user_id=p.user_id
   JOIN courier_store_links link ON link.courier_profile_id=p.id AND link.tenant_id=member.tenant_id
   JOIN stores store ON store.id=link.store_id JOIN tenants tenant ON tenant.id=store.tenant_id
   WHERE p.id=NEW.courier_profile_id AND p.status='ACTIVE' AND member.status='ACTIVE' AND member.role='COURIER'
    AND link.status='ACTIVE' AND store.status='ACTIVE' AND tenant.status='ACTIVE'
   ON CONFLICT(tenant_id,courier_profile_id) DO UPDATE SET status=EXCLUDED.status,latitude=EXCLUDED.latitude,
    longitude=EXCLUDED.longitude,accuracy=EXCLUDED.accuracy,interest_radius_m=EXCLUDED.interest_radius_m,
    available_until=EXCLUDED.available_until,updated_by=EXCLUDED.updated_by;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER global_availability_changed AFTER INSERT OR UPDATE ON courier_service_preferences
 FOR EACH ROW EXECUTE PROCEDURE sync_global_availability();

CREATE FUNCTION rastreia.courier_matches_preferences(profile_id uuid,unit_id uuid,modality text,service_start timestamptz,service_end timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM courier_profiles p JOIN users u ON u.id=p.user_id WHERE p.id=profile_id
   AND p.status='ACTIVE' AND u.status='ACTIVE' AND u.email_verified_at IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.courier_profile_id=profile_id
    AND d.status IN ('AWAITING_PICKUP','COLLECTED','IN_ROUTE','NEXT_STOP'))
 AND NOT EXISTS(SELECT 1 FROM shift_positions p JOIN shift_slots slot ON slot.id=p.slot_id WHERE p.assigned_courier_id=profile_id
    AND p.status IN ('FILLED','ACTIVE') AND slot.starts_at<service_end AND slot.ends_at>service_start)
 AND (NOT EXISTS(SELECT 1 FROM courier_service_preferences WHERE courier_profile_id=profile_id)
 OR EXISTS(SELECT 1 FROM courier_service_preferences pref JOIN stores store ON store.id=unit_id JOIN tenants tenant ON tenant.id=store.tenant_id
  WHERE pref.courier_profile_id=profile_id AND pref.registration_status='APPROVED' AND pref.availability_status='AVAILABLE'
   AND pref.location_expires_at>now() AND lower(trim(pref.base_city))=lower(trim(store.city))
   AND (modality=ANY(pref.modalities) OR (modality='FIXED_SHIFT' AND 'REPLACEMENT'=ANY(pref.modalities)))
   AND (jsonb_array_length(pref.interests)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(pref.interests) area
      WHERE lower(trim(area))=lower(trim(store.neighborhood))))
   AND (jsonb_array_length(pref.availability_windows)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(pref.availability_windows) time_window
     WHERE (time_window->>'day')::int=extract(dow FROM service_start AT TIME ZONE tenant.timezone)::int
      AND (service_start AT TIME ZONE tenant.timezone)::date=(service_end AT TIME ZONE tenant.timezone)::date
      AND (service_start AT TIME ZONE tenant.timezone)::time >= (time_window->>'start')::time
      AND (service_end AT TIME ZONE tenant.timezone)::time <= (time_window->>'end')::time))))
$$;
REVOKE ALL ON FUNCTION rastreia.courier_matches_preferences(uuid,uuid,text,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.courier_matches_preferences(uuid,uuid,text,timestamptz,timestamptz) TO rastreia_runtime;

-- Accepting a previously published offer is still a new operation; completion is not.
CREATE FUNCTION rastreia.guard_unit_assignment() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
BEGIN
 IF (TG_TABLE_NAME='delivery_offers' AND OLD.status::text='PUBLISHED' AND NEW.status::text='ACCEPTED')
   OR (TG_TABLE_NAME='deliveries' AND OLD.status::text IN ('DRAFT','AWAITING_COURIER') AND NEW.status::text IN ('ASSIGNED','AWAITING_PICKUP')) THEN
   PERFORM id FROM stores WHERE id=NEW.store_id FOR SHARE;
   IF NOT unit_accepts_new_operations(NEW.store_id) THEN RAISE EXCEPTION 'UNIT_UNAVAILABLE' USING ERRCODE='P0001'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER offer_accept_unit_available BEFORE UPDATE ON delivery_offers FOR EACH ROW EXECUTE PROCEDURE guard_unit_assignment();
CREATE TRIGGER delivery_assignment_unit_available BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE PROCEDURE guard_unit_assignment();

-- Prevent two public identities with the same normalized phone; no existing identities are merged or deleted.
CREATE OR REPLACE FUNCTION rastreia.register_courier_identity(requested_id uuid,requested_name text,
 requested_email text,requested_password_hash text,requested_phone text,requested_vehicle text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
DECLARE profile_id uuid; normalized_phone text;
BEGIN
 normalized_phone:=regexp_replace(requested_phone,'[^0-9]','','g');
 PERFORM pg_advisory_xact_lock(hashtext(normalized_phone));
 IF EXISTS(SELECT 1 FROM courier_profiles WHERE regexp_replace(phone,'[^0-9]','','g')=normalized_phone) THEN RETURN NULL; END IF;
 INSERT INTO users(id,name,email,password_hash,email_verified_at) VALUES(requested_id,requested_name,requested_email,requested_password_hash,NULL);
 INSERT INTO courier_profiles(user_id,phone,vehicle_type,status) VALUES(requested_id,requested_phone,requested_vehicle::vehicle_type,'PENDING') RETURNING id INTO profile_id;
 RETURN profile_id;
END $$;
