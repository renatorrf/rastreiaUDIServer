SET LOCAL search_path TO rastreia, public;

CREATE FUNCTION rastreia.customer_order_history(requested_customer uuid)
RETURNS TABLE (
  id uuid,
  reference text,
  status delivery_status,
  "createdAt" timestamptz,
  "deliveredAt" timestamptz,
  "addressLine" text,
  "addressNumber" text,
  "storeName" text,
  "storeWhatsapp" text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = rastreia, public, pg_temp
AS $$
  SELECT delivery.id,
         delivery.external_reference,
         delivery.status,
         delivery.created_at,
         delivery.delivered_at,
         delivery.address_line,
         delivery.address_number,
         store.name,
         store.contact_phone
  FROM customer_profiles profile
  JOIN deliveries delivery
    ON delivery.customer_profile_id = profile.id
   AND delivery.tenant_id = profile.tenant_id
  JOIN stores store ON store.id = delivery.store_id
  WHERE profile.id = requested_customer
    AND profile.tenant_id = rastreia.current_tenant_id()
    AND (
      profile.user_id = rastreia.current_user_id()
      OR EXISTS (
        SELECT 1
        FROM customer_sessions session
        WHERE session.customer_profile_id = profile.id
          AND session.tenant_id = profile.tenant_id
          AND session.token_hash = NULLIF(current_setting('app.customer_session_hash', true), '')
          AND session.revoked_at IS NULL
          AND session.expires_at > now()
      )
    )
  ORDER BY delivery.created_at DESC
  LIMIT 100
$$;

REVOKE ALL ON FUNCTION rastreia.customer_order_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.customer_order_history(uuid) TO rastreia_runtime;
