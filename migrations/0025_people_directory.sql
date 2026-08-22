SET LOCAL search_path TO rastreia, public;

-- Gestores precisam continuar vendo vínculos bloqueados/encerrados para poder
-- auditá-los e reativá-los. O isolamento permanece pelo vínculo com o tenant.
DROP POLICY users_tenant_visibility ON users;
CREATE POLICY users_tenant_visibility ON users
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tenant_users membership
      WHERE membership.user_id = users.id
        AND membership.tenant_id = rastreia.current_tenant_id()
    )
  );

DROP POLICY courier_profiles_visibility ON courier_profiles;
CREATE POLICY courier_profiles_visibility ON courier_profiles
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tenant_users membership
      WHERE membership.user_id = courier_profiles.user_id
        AND membership.tenant_id = rastreia.current_tenant_id()
        AND membership.role = 'COURIER'
    )
  );

-- Resolução mínima para conectar uma identidade já existente a outro tenant.
-- Nenhum segredo ou dado operacional de outro tenant é retornado.
CREATE OR REPLACE FUNCTION rastreia.resolve_user_email(requested_email text)
RETURNS TABLE (
  id uuid,
  name text,
  email citext,
  status user_status,
  courier_profile_id uuid,
  courier_profile_status courier_status
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = rastreia, public, pg_temp
AS $$
  SELECT account.id, account.name, account.email, account.status, profile.id, profile.status
  FROM users account
  LEFT JOIN courier_profiles profile ON profile.user_id = account.id
  WHERE account.email = requested_email::citext
  LIMIT 1
$$;

-- Valida a sessão contra o estado atual. Assim, bloqueios e alterações de papel
-- ou escopo de lojas invalidam imediatamente access tokens ainda não expirados.
CREATE OR REPLACE FUNCTION rastreia.tenant_session_is_current(
  requested_tenant_id uuid,
  requested_user_id uuid,
  requested_role text,
  requested_store_ids uuid[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = rastreia, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM tenants tenant
    JOIN tenant_users membership ON membership.tenant_id = tenant.id
    JOIN users account ON account.id = membership.user_id
    WHERE tenant.id = requested_tenant_id
      AND tenant.status = 'ACTIVE'
      AND membership.user_id = requested_user_id
      AND membership.status = 'ACTIVE'
      AND account.status = 'ACTIVE'
      AND membership.role::text = requested_role
      AND NOT EXISTS (
        SELECT 1
        FROM user_store_access access
        WHERE access.tenant_user_id = membership.id
          AND NOT (access.store_id = ANY(COALESCE(requested_store_ids, '{}'::uuid[])))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(COALESCE(requested_store_ids, '{}'::uuid[])) claimed_store_id
        WHERE NOT EXISTS (
          SELECT 1 FROM user_store_access access
          WHERE access.tenant_user_id = membership.id
            AND access.store_id = claimed_store_id
        )
      )
  )
$$;

REVOKE ALL ON FUNCTION rastreia.resolve_user_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rastreia.tenant_session_is_current(uuid, uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.resolve_user_email(text) TO rastreia_runtime;
GRANT EXECUTE ON FUNCTION rastreia.tenant_session_is_current(uuid, uuid, text, uuid[]) TO rastreia_runtime;
