SET LOCAL search_path TO rastreia, public;

CREATE FUNCTION rastreia.link_customer_delivery_history(
  requested_profile uuid,
  requested_token uuid,
  requested_phone_variants text[],
  requested_grace_seconds integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rastreia, public, pg_temp
AS $$
DECLARE
  linked_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM customer_profiles profile
    JOIN tracking_tokens token
      ON token.id = profile.source_tracking_token_id
     AND token.tenant_id = profile.tenant_id
    WHERE profile.id = requested_profile
      AND token.id = requested_token
      AND profile.tenant_id = rastreia.current_tenant_id()
      AND token.revoked_at IS NULL
      AND token.expires_at
        + LEAST(GREATEST(requested_grace_seconds, 0), 31536000) * interval '1 second' > now()
  ) THEN
    RAISE EXCEPTION 'invalid customer registration context';
  END IF;

  UPDATE deliveries delivery
  SET customer_profile_id = requested_profile
  WHERE delivery.tenant_id = rastreia.current_tenant_id()
    AND delivery.customer_profile_id IS NULL
    AND regexp_replace(
      COALESCE(NULLIF(delivery.recipient_whatsapp, ''), delivery.recipient_phone),
      '[^0-9]', '', 'g'
    ) = ANY(requested_phone_variants);

  GET DIAGNOSTICS linked_count = ROW_COUNT;
  RETURN linked_count;
END
$$;

REVOKE ALL ON FUNCTION rastreia.link_customer_delivery_history(uuid, uuid, text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.link_customer_delivery_history(uuid, uuid, text[], integer) TO rastreia_runtime;
