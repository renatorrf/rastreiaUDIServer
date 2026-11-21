SET LOCAL search_path=rastreia,public;

-- Country code only when the length proves its presence; never guess missing digits.
CREATE FUNCTION retention_phone(raw text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 WITH digits AS (SELECT regexp_replace(raw,'[[:space:]().+-]','','g') AS n),
 national AS (SELECT CASE WHEN n ~ '^55[0-9]{10,11}$' THEN substr(n,3) ELSE n END AS n FROM digits)
 SELECT CASE WHEN n ~ '^(1[1-9]|2[12478]|3[1-578]|4[1-9]|5[1345]|6[1-9]|7[134579]|8[1-9]|9[1-9])(9[0-9]{8}|[2-5][0-9]{7})$' THEN '55'||n END FROM national
$$;
CREATE FUNCTION retention_delivery_phone(source text,whatsapp text,telephone text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT retention_phone(coalesce(nullif(trim(whatsapp),''),CASE WHEN source<>'IFOOD' THEN telephone END))
$$;
CREATE TABLE retention_phone_consents (
 id bigserial PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), whatsapp text NOT NULL CHECK(retention_phone(whatsapp) IS NOT NULL AND retention_phone(whatsapp)=whatsapp),
 enabled boolean NOT NULL, proof_ref text NOT NULL CHECK(length(proof_ref) BETWEEN 3 AND 160),
 actor_id uuid NOT NULL REFERENCES users(id), recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retention_phone_consent_history ON retention_phone_consents(store_id,whatsapp,id DESC);
ALTER TABLE retention_phone_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_phone_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY retention_phone_manager_read ON retention_phone_consents FOR SELECT USING(commerce_manage_store(store_id));
CREATE POLICY retention_phone_manager_record ON retention_phone_consents FOR INSERT WITH CHECK(commerce_manage_store(store_id) AND actor_id=current_user_id());
GRANT SELECT,INSERT ON retention_phone_consents TO rastreia_runtime;
GRANT USAGE ON SEQUENCE retention_phone_consents_id_seq TO rastreia_runtime;
CREATE TRIGGER retention_phone_guard BEFORE INSERT ON retention_phone_consents FOR EACH ROW EXECUTE PROCEDURE retention_check_optin();

ALTER TABLE retention_offers ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE retention_offers ADD COLUMN phone_consent_id bigint REFERENCES retention_phone_consents(id);
ALTER TABLE retention_offers ADD COLUMN source_delivery_id uuid REFERENCES deliveries(id);
ALTER TABLE retention_offers ADD CHECK((phone_consent_id IS NULL)=(source_delivery_id IS NULL) AND (user_id IS NOT NULL OR phone_consent_id IS NOT NULL));
CREATE INDEX retention_offer_consent ON retention_offers(phone_consent_id) WHERE phone_consent_id IS NOT NULL;

-- Only expose suppression for a number on a completed delivery of this manager's unit.
CREATE FUNCTION retention_contact_blocked(unit uuid,delivery uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM deliveries d JOIN retention_whatsapp_stops s
 ON s.phone_key=retention_delivery_phone(d.origin,d.recipient_whatsapp,d.recipient_phone)
 WHERE commerce_manage_store(unit) AND d.store_id=unit AND d.id=delivery AND d.status='DELIVERED')
$$;
CREATE FUNCTION retention_claim_phone_offer(offer uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 UPDATE retention_offers o SET user_id=current_user_id() FROM retention_phone_consents pc, stores s
 WHERE o.id=offer AND o.user_id IS NULL AND o.order_id IS NULL AND o.expires_at>now() AND o.dispatch IN ('ACCEPTED','UNKNOWN','PROCESSING')
 AND pc.id=o.phone_consent_id AND pc.store_id=o.store_id AND s.id=o.store_id
 AND EXISTS(SELECT 1 FROM customer_profiles cp JOIN users u ON u.id=cp.user_id
 WHERE cp.user_id=current_user_id() AND cp.tenant_id=s.tenant_id AND cp.status='ACTIVE' AND retention_phone(u.customer_login_phone)=pc.whatsapp AND retention_phone(cp.whatsapp_normalized)=pc.whatsapp)
$$;
REVOKE ALL ON FUNCTION retention_contact_blocked(uuid,uuid),retention_claim_phone_offer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention_contact_blocked(uuid,uuid),retention_claim_phone_offer(uuid) TO rastreia_runtime;
