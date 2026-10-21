SET LOCAL search_path TO rastreia, public;

-- The operational RLS deliberately excludes customers. Do NOT grant them a
-- whole store: expose only a snapshot of a delivery owned by their session.
CREATE FUNCTION rastreia.customer_tracking_snapshot(requested_order uuid,requested_customer uuid,
  requested_tenant uuid,completed_grace integer,token_ttl integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=rastreia,public,pg_temp AS $$
DECLARE snapshot jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM customer_profiles profile
    JOIN deliveries delivery ON delivery.customer_profile_id=profile.id AND delivery.tenant_id=profile.tenant_id
    WHERE delivery.id=requested_order AND profile.id=requested_customer AND profile.tenant_id=requested_tenant
      AND profile.status='ACTIVE' AND rastreia.tenant_is_active(profile.tenant_id)
      AND (
        (profile.user_id=rastreia.current_user_id() AND EXISTS (
          SELECT 1 FROM users account WHERE account.id=profile.user_id AND account.status='ACTIVE'))
        OR EXISTS (SELECT 1 FROM customer_sessions session WHERE session.customer_profile_id=profile.id
          AND session.tenant_id=profile.tenant_id AND session.revoked_at IS NULL AND session.expires_at>now()
          AND session.token_hash=NULLIF(current_setting('app.customer_session_hash',true),''))
      )
  ) THEN RETURN NULL; END IF;

  SELECT to_jsonb(record) INTO snapshot FROM (SELECT delivery.tenant_id AS "tenantId",
            store.name AS "storeName", store.contact_phone AS "storeContactPhone",
            delivery.external_reference AS "externalReference",
            courier_user.name AS "courierName", delivery.status,
            delivery.address_line AS "addressLine", delivery.address_number AS "addressNumber",
            delivery.neighborhood, delivery.city, delivery.state,
            delivery.postal_code AS "postalCode",
            delivery.latitude AS "destinationLatitude",
            delivery.longitude AS "destinationLongitude",
            delivery.promised_window_start AS "promisedWindowStart",
            delivery.promised_window_end AS "promisedWindowEnd",
            delivery.delivered_at AS "deliveredAt", delivery.updated_at AS "updatedAt",
            last_location.latitude AS "locationLatitude",
            last_location.longitude AS "locationLongitude",
            last_location.accuracy AS "locationAccuracy",
            last_location.heading AS "locationHeading",
            last_location.captured_at AS "locationCapturedAt",
            proof.id AS "proofId", proof.recipient_name AS "proofRecipientName",
            proof.created_at AS "proofCreatedAt",
            route_stop.estimated_arrival_at AS "estimatedArrivalAt",
            route.eta_calculated_at AS "etaCalculatedAt",
            EXISTS (SELECT 1 FROM route_stops previous_stop
              WHERE previous_stop.route_id = delivery.route_id AND previous_stop.stop_type = 'DELIVERY'
                AND previous_stop.status = 'PENDING' AND previous_stop.sequence < route_stop.sequence) AS "hasPreviousStops",
            COALESCE(
              delivery.delivered_at + (completed_grace::text || ' seconds')::interval,
              now() + (token_ttl::text || ' seconds')::interval
            ) AS "expiresAt"
     FROM deliveries delivery
     JOIN stores store ON store.id = delivery.store_id
     LEFT JOIN courier_profiles courier ON courier.id = delivery.courier_profile_id
     LEFT JOIN users courier_user ON courier_user.id = courier.user_id
     LEFT JOIN routes route ON route.id = delivery.route_id
     LEFT JOIN route_stops route_stop ON route_stop.route_id = delivery.route_id
       AND route_stop.delivery_id = delivery.id AND route_stop.stop_type = 'DELIVERY'
     LEFT JOIN courier_last_locations last_location
       ON last_location.tenant_id = delivery.tenant_id
      AND last_location.courier_profile_id = delivery.courier_profile_id
      AND last_location.delivery_id = delivery.id
     LEFT JOIN LATERAL (
       SELECT candidate.id, candidate.recipient_name, candidate.created_at
       FROM delivery_proofs candidate
       WHERE candidate.delivery_id = delivery.id AND candidate.public_visible
       ORDER BY candidate.created_at DESC LIMIT 1
     ) proof ON true
     WHERE delivery.id = requested_order AND delivery.customer_profile_id = requested_customer AND delivery.tenant_id = requested_tenant) record;
  RETURN jsonb_build_object('delivery',snapshot,
    'history',COALESCE((SELECT jsonb_agg(row_to_json(record)) FROM (
      SELECT to_status AS status,created_at AS "occurredAt" FROM delivery_status_history
      WHERE delivery_id=requested_order ORDER BY delivery_version
    ) record),'[]'::jsonb),
    'notices',COALESCE((SELECT jsonb_agg(row_to_json(record)) FROM (
      SELECT event.status,CASE WHEN event.status='OPEN'
        THEN 'Houve um imprevisto durante a entrega. A previsão poderá sofrer alteração.'
        ELSE 'O imprevisto informado foi encerrado.' END AS message,
        event.occurred_at AS "occurredAt",event.resolved_at AS "resolvedAt",
        event.affects_eta AND event.status='OPEN' AS "affectsEta"
      FROM driver_operational_events event
      WHERE event.tenant_id=requested_tenant AND event.customer_visibility IN ('GENERIC','VISIBLE')
        AND EXISTS(SELECT 1 FROM driver_event_deliveries affected
          WHERE affected.event_id=event.id AND affected.delivery_id=requested_order)
      ORDER BY event.occurred_at DESC LIMIT 50
    ) record),'[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION rastreia.customer_tracking_snapshot(uuid,uuid,uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.customer_tracking_snapshot(uuid,uuid,uuid,integer,integer) TO rastreia_runtime;

-- A shared phone/browser must not keep delivering another customer's messages.
-- Only the authenticated owner can claim an endpoint for their own profile.
CREATE FUNCTION rastreia.claim_customer_push_endpoint(requested_profile uuid,requested_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE owner_id uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM customer_profiles profile WHERE profile.id=requested_profile AND profile.status='ACTIVE'
    AND profile.tenant_id=current_tenant_id() AND (
      (profile.user_id=current_user_id() AND EXISTS(SELECT 1 FROM users account WHERE account.id=profile.user_id AND account.status='ACTIVE'))
      OR EXISTS(SELECT 1 FROM customer_sessions session WHERE session.customer_profile_id=profile.id
        AND session.tenant_id=profile.tenant_id AND session.token_hash=NULLIF(current_setting('app.customer_session_hash',true),'')
        AND session.revoked_at IS NULL AND session.expires_at>now())))
  THEN RAISE EXCEPTION 'customer push ownership required' USING ERRCODE='42501'; END IF;
  SELECT user_id INTO owner_id FROM customer_profiles WHERE id=requested_profile;
  PERFORM pg_advisory_xact_lock(hashtext('customer-push:' || requested_hash));
  UPDATE customer_push_subscriptions subscription SET active=false
  FROM customer_profiles profile WHERE subscription.customer_profile_id=profile.id
    AND subscription.tenant_id=profile.tenant_id AND subscription.endpoint_hash=requested_hash
    AND profile.id<>requested_profile AND (owner_id IS NULL OR profile.user_id IS DISTINCT FROM owner_id);
END $$;
REVOKE ALL ON FUNCTION rastreia.claim_customer_push_endpoint(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.claim_customer_push_endpoint(uuid,text) TO rastreia_runtime;
