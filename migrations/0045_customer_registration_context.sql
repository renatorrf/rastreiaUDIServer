SET LOCAL search_path TO rastreia, public;

-- The public tracking policy intentionally hides expired deliveries. Customer
-- registration has a separate, bounded grace period, so expose only the four
-- fields required to validate that flow instead of widening delivery RLS.
CREATE FUNCTION rastreia.customer_registration_context(
  requested_hash text,
  requested_grace_seconds integer
)
RETURNS TABLE (
  token_id uuid,
  tenant_id uuid,
  delivery_id uuid,
  recipient_phone text,
  recipient_whatsapp text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = rastreia, public, pg_temp
AS $$
  SELECT token.id, token.tenant_id, token.delivery_id,
         delivery.recipient_phone, delivery.recipient_whatsapp
  FROM tracking_tokens token
  JOIN deliveries delivery
    ON delivery.id = token.delivery_id
   AND delivery.tenant_id = token.tenant_id
  WHERE token.token_hash = requested_hash
    AND token.revoked_at IS NULL
    AND token.expires_at
      + LEAST(GREATEST(requested_grace_seconds, 0), 31536000) * interval '1 second' > now()
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION rastreia.customer_registration_context(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.customer_registration_context(text, integer) TO rastreia_runtime;
