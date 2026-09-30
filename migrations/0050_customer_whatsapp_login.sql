SET LOCAL search_path TO rastreia, public;

-- Merchant-entered contact data is a pre-registration, not customer consent.
ALTER TABLE customer_profiles ALTER COLUMN consent_at DROP NOT NULL;
ALTER TABLE customer_profiles ALTER COLUMN consent_at DROP DEFAULT;
ALTER TABLE customer_profiles DROP CONSTRAINT customer_profiles_last_name_check;
ALTER TABLE customer_profiles ADD CONSTRAINT customer_profiles_last_name_check CHECK (char_length(last_name) <= 120);

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN customer_login_phone text UNIQUE
  CHECK (customer_login_phone ~ '^[1-9][0-9]{9,10}$');
ALTER TABLE users ADD CONSTRAINT users_login_required CHECK (email IS NOT NULL OR customer_login_phone IS NOT NULL);

-- Existing passwords and email login remain valid. Ambiguous/shared numbers
-- and operational identities are deliberately not converted automatically.
WITH candidates AS (
  SELECT whatsapp_normalized AS phone, min(user_id::text)::uuid AS user_id
  FROM customer_profiles WHERE user_id IS NOT NULL AND status='ACTIVE'
  GROUP BY whatsapp_normalized HAVING count(DISTINCT user_id)=1
), unique_users AS (
  SELECT user_id FROM candidates GROUP BY user_id HAVING count(*)=1
)
UPDATE users account SET customer_login_phone=candidate.phone
FROM candidates candidate JOIN unique_users unique_account USING(user_id)
WHERE account.id=candidate.user_id
  AND NOT EXISTS (SELECT 1 FROM tenant_users WHERE user_id=account.id)
  AND NOT EXISTS (SELECT 1 FROM courier_profiles WHERE user_id=account.id)
  AND account.email_verified_at IS NOT NULL;

CREATE FUNCTION rastreia.customer_identity_by_phone(requested_phone text)
RETURNS TABLE(id uuid,password_hash text,status user_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT account.id,account.password_hash,account.status FROM users account
 WHERE account.customer_login_phone=requested_phone
   AND EXISTS (SELECT 1 FROM customer_profiles profile WHERE profile.user_id=account.id AND profile.status='ACTIVE')
 LIMIT 1
$$;
REVOKE ALL ON FUNCTION rastreia.customer_identity_by_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.customer_identity_by_phone(text) TO rastreia_runtime;

-- This capability exposes only the order needed for first activation, even
-- during the bounded registration grace period; it does not widen delivery RLS.
CREATE FUNCTION rastreia.customer_activation_order(requested_hash text,requested_grace integer)
RETURNS TABLE(token_id uuid,tenant_id uuid,delivery jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT context.token_id,context.tenant_id,jsonb_build_object(
   'recipientName',delivery.recipient_name,'recipientPhone',delivery.recipient_phone,
   'recipientWhatsapp',delivery.recipient_whatsapp,'addressLine',delivery.address_line,
   'addressNumber',delivery.address_number,'complement',delivery.complement,
   'neighborhood',delivery.neighborhood,'city',delivery.city,'state',delivery.state,
   'postalCode',delivery.postal_code,'latitude',delivery.latitude,'longitude',delivery.longitude,
   'addressConfidence',delivery.address_confidence)
 FROM rastreia.customer_registration_context(requested_hash,requested_grace) context
 JOIN deliveries delivery ON delivery.id=context.delivery_id AND delivery.tenant_id=context.tenant_id
$$;
REVOKE ALL ON FUNCTION rastreia.customer_activation_order(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.customer_activation_order(text,integer) TO rastreia_runtime;

CREATE FUNCTION rastreia.activate_customer_password(requested_profile uuid,requested_hash text,requested_grace integer,requested_password_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE profile customer_profiles%ROWTYPE; new_user uuid;
BEGIN
 SELECT * INTO profile FROM customer_profiles WHERE id=requested_profile
   AND tenant_id=rastreia.current_tenant_id() AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND OR profile.user_id IS NOT NULL THEN RETURN NULL; END IF;
 IF NOT EXISTS (SELECT 1 FROM rastreia.customer_registration_context(requested_hash,requested_grace) context
   WHERE context.tenant_id=profile.tenant_id AND context.token_id=profile.source_tracking_token_id) THEN RETURN NULL; END IF;
 -- Serialize first activation across tenants for the same phone.
 PERFORM pg_advisory_xact_lock(hashtext('customer-phone:' || profile.whatsapp_normalized));
 IF EXISTS(SELECT 1 FROM users WHERE customer_login_phone=profile.whatsapp_normalized) THEN RETURN NULL; END IF;
 new_user := gen_random_uuid();
 INSERT INTO users(id,name,email,customer_login_phone,password_hash,must_change_password)
 VALUES(new_user,trim(profile.first_name || ' ' || profile.last_name),NULL,profile.whatsapp_normalized,requested_password_hash,false);
 UPDATE customer_profiles SET user_id=new_user,consent_at=now() WHERE id=profile.id;
 RETURN new_user;
END $$;
REVOKE ALL ON FUNCTION rastreia.activate_customer_password(uuid,text,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.activate_customer_password(uuid,text,integer,text) TO rastreia_runtime;

-- A phone identity can activate profiles in more than one tenant. History and
-- tracking must use ownership, never a supplied phone or whichever tenant was last.
CREATE FUNCTION rastreia.customer_identity_orders()
RETURNS TABLE(id uuid,reference text,status delivery_status,"createdAt" timestamptz,"deliveredAt" timestamptz,
  "addressLine" text,"addressNumber" text,"storeName" text,"storeWhatsapp" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT delivery.id,delivery.external_reference,delivery.status,delivery.created_at,delivery.delivered_at,
   delivery.address_line,delivery.address_number,store.name,store.contact_phone
 FROM customer_profiles profile JOIN deliveries delivery ON delivery.customer_profile_id=profile.id AND delivery.tenant_id=profile.tenant_id
 JOIN stores store ON store.id=delivery.store_id
 WHERE profile.user_id=rastreia.current_user_id() AND profile.status='ACTIVE'
 ORDER BY delivery.created_at DESC LIMIT 100
$$;
CREATE FUNCTION rastreia.customer_identity_order_scope(requested_order uuid)
RETURNS TABLE(id uuid,tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT profile.id,profile.tenant_id FROM customer_profiles profile
 JOIN deliveries delivery ON delivery.customer_profile_id=profile.id AND delivery.tenant_id=profile.tenant_id
 WHERE delivery.id=requested_order AND profile.user_id=rastreia.current_user_id() AND profile.status='ACTIVE'
$$;
REVOKE ALL ON FUNCTION rastreia.customer_identity_orders(),rastreia.customer_identity_order_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.customer_identity_orders(),rastreia.customer_identity_order_scope(uuid) TO rastreia_runtime;
