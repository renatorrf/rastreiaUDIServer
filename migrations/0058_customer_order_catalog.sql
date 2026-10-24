SET LOCAL search_path TO rastreia, public;

-- Enrich only the history already authorized by the existing identity/session
-- functions. No direct storefront privilege or customer RLS policy is added.
CREATE FUNCTION rastreia.customer_orders_with_catalog(requested_customer uuid DEFAULT NULL)
RETURNS TABLE(data jsonb)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = rastreia, public, pg_temp
AS $$
  WITH authorized_history AS (
    SELECT * FROM rastreia.customer_identity_orders() WHERE requested_customer IS NULL
    UNION ALL
    SELECT * FROM rastreia.customer_order_history(requested_customer) WHERE requested_customer IS NOT NULL
  )
  SELECT to_jsonb(history) || jsonb_build_object('storeCatalogSlug',
    CASE WHEN rastreia.commerce_public_store(front.slug) IS NOT NULL THEN front.slug ELSE NULL END)
  FROM authorized_history history
  JOIN deliveries delivery ON delivery.id = history.id
  LEFT JOIN commerce_storefronts front
    ON front.store_id = delivery.store_id AND front.tenant_id = delivery.tenant_id
  ORDER BY history."createdAt" DESC, history.id
$$;

REVOKE ALL ON FUNCTION rastreia.customer_orders_with_catalog(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.customer_orders_with_catalog(uuid) TO rastreia_runtime;
