SET LOCAL search_path TO rastreia, public;

ALTER TABLE users ADD COLUMN email_verified_at timestamptz DEFAULT now();
ALTER TABLE users ALTER COLUMN email_verified_at DROP DEFAULT;
ALTER TABLE stores ADD COLUMN plan_code text NOT NULL DEFAULT 'unconfigured';
ALTER TABLE stores ADD COLUMN operational_limits jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE stores ADD COLUMN operational_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE identity_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('INVITE', 'VERIFY_EMAIL', 'RESET_PASSWORD')),
  token_hash char(64) NOT NULL UNIQUE,
  tenant_id uuid REFERENCES tenants(id),
  store_id uuid REFERENCES stores(id),
  requires_password boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity_sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  token_hash char(64) NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE email_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedup_key text NOT NULL UNIQUE, encrypted_payload text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','EXPIRED')),
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, sent_at timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_jobs_pending_idx ON email_jobs(available_at) WHERE status = 'PENDING';

CREATE TABLE courier_service_preferences (
  courier_profile_id uuid PRIMARY KEY REFERENCES courier_profiles(id),
  registration_status text NOT NULL DEFAULT 'EMAIL_PENDING'
    CHECK (registration_status IN ('DRAFT','EMAIL_PENDING','IN_REVIEW','APPROVED','REJECTED','SUSPENDED')),
  base_city text NOT NULL, reference_region text NOT NULL DEFAULT '',
  radius_m integer NOT NULL CHECK (radius_m BETWEEN 500 AND 100000),
  interests jsonb NOT NULL DEFAULT '[]'::jsonb,
  modalities text[] NOT NULL DEFAULT '{FIXED_SHIFT,REPLACEMENT,ONE_OFF}',
  availability_windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  availability_status text NOT NULL DEFAULT 'OFFLINE'
    CHECK (availability_status IN ('OFFLINE','AVAILABLE','BUSY','ON_SHIFT','PAUSED')),
  latitude double precision CHECK(latitude BETWEEN -90 AND 90),
  longitude double precision CHECK(longitude BETWEEN -180 AND 180),
  accuracy double precision CHECK(accuracy BETWEEN 0 AND 100),
  location_authorized_at timestamptz, location_expires_at timestamptz,
  terms_version text NOT NULL, privacy_version text NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION rastreia.is_master() RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM platform_admins WHERE id = current_platform_admin_id() AND status = 'ACTIVE')
$$;
REVOKE ALL ON FUNCTION rastreia.is_master() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.is_master() TO rastreia_runtime;

CREATE POLICY users_identity_select ON users FOR SELECT USING (id = current_user_id() OR is_master());
CREATE POLICY users_master_insert ON users FOR INSERT WITH CHECK (is_master());
CREATE POLICY users_identity_update ON users FOR UPDATE USING (id = current_user_id() OR is_master());
CREATE POLICY stores_master ON stores USING (is_master()) WITH CHECK (is_master());
CREATE POLICY tenant_users_master ON tenant_users USING (is_master()) WITH CHECK (is_master());
CREATE POLICY user_store_access_master ON user_store_access USING (is_master()) WITH CHECK (is_master());
CREATE POLICY courier_profiles_self ON courier_profiles USING (user_id = current_user_id() OR is_master())
  WITH CHECK (user_id = current_user_id() OR is_master());
ALTER TABLE courier_service_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_service_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY courier_preferences_self ON courier_service_preferences
  USING (is_master() OR EXISTS (SELECT 1 FROM courier_profiles WHERE id = courier_profile_id AND user_id = current_user_id()))
  WITH CHECK (is_master() OR EXISTS (SELECT 1 FROM courier_profiles WHERE id = courier_profile_id AND user_id = current_user_id()));
ALTER TABLE identity_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_sessions_self ON identity_sessions USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());
ALTER TABLE identity_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_actions_self ON identity_actions USING (user_id = current_user_id() OR is_master())
  WITH CHECK (user_id = current_user_id() OR is_master());
ALTER TABLE email_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_jobs FORCE ROW LEVEL SECURITY;
-- No SELECT privilege for runtime: the worker alone decrypts pending mail.
CREATE POLICY email_jobs_insert ON email_jobs FOR INSERT WITH CHECK (is_master() OR current_user_id() IS NOT NULL);
GRANT SELECT, INSERT, UPDATE ON identity_actions, identity_sessions, courier_service_preferences TO rastreia_runtime;
GRANT INSERT ON email_jobs TO rastreia_runtime;

CREATE OR REPLACE FUNCTION rastreia.identity_by_email(requested_email text)
RETURNS TABLE (id uuid, name text, email citext, password_hash text, status user_status, email_verified_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
 SELECT id, name, email, password_hash, status, email_verified_at FROM users WHERE email = requested_email::citext LIMIT 1
$$;
CREATE OR REPLACE FUNCTION rastreia.identity_action_user(requested_hash text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
 SELECT user_id FROM identity_actions WHERE token_hash = requested_hash AND consumed_at IS NULL AND expires_at > now()
$$;
CREATE OR REPLACE FUNCTION rastreia.register_courier_identity(requested_id uuid, requested_name text,
 requested_email text, requested_password_hash text, requested_phone text, requested_vehicle text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
DECLARE profile_id uuid;
BEGIN
 INSERT INTO users(id, name, email, password_hash, email_verified_at)
 VALUES(requested_id, requested_name, requested_email, requested_password_hash, NULL);
 INSERT INTO courier_profiles(user_id, phone, vehicle_type, status)
 VALUES(requested_id, requested_phone, requested_vehicle::vehicle_type, 'PENDING') RETURNING id INTO profile_id;
 RETURN profile_id;
END $$;
CREATE OR REPLACE FUNCTION rastreia.identity_units(requested_user uuid)
RETURNS TABLE (id uuid, name text, tenant_id uuid, tenant_slug citext, tenant_name text, role tenant_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
 SELECT DISTINCT store.id, store.name, tenant.id, tenant.slug, tenant.name, membership.role
 FROM tenant_users membership JOIN tenants tenant ON tenant.id = membership.tenant_id AND tenant.status = 'ACTIVE'
 JOIN stores store ON store.tenant_id = tenant.id AND store.status = 'ACTIVE'
 JOIN users account ON account.id = membership.user_id AND account.status = 'ACTIVE' AND account.email_verified_at IS NOT NULL
 WHERE membership.user_id = requested_user AND membership.status = 'ACTIVE' AND requested_user = current_user_id()
 AND (EXISTS (SELECT 1 FROM user_store_access access WHERE access.tenant_user_id = membership.id AND access.store_id = store.id)
 OR (membership.role = 'COURIER' AND EXISTS (SELECT 1 FROM courier_store_links link
 JOIN courier_profiles profile ON profile.id = link.courier_profile_id
 WHERE link.store_id = store.id AND link.status = 'ACTIVE' AND profile.user_id = requested_user AND profile.status = 'ACTIVE')))
 ORDER BY tenant.name, store.name
$$;
REVOKE ALL ON FUNCTION rastreia.identity_by_email(text), rastreia.identity_action_user(text),
 rastreia.register_courier_identity(uuid,text,text,text,text,text), rastreia.identity_units(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.identity_by_email(text), rastreia.identity_action_user(text),
 rastreia.register_courier_identity(uuid,text,text,text,text,text), rastreia.identity_units(uuid) TO rastreia_runtime;

CREATE OR REPLACE FUNCTION rastreia.revoke_identity_credentials(requested_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
BEGIN
 IF requested_user IS DISTINCT FROM current_user_id() THEN RAISE EXCEPTION 'identity mismatch'; END IF;
 UPDATE tenant_users SET password_hash=NULL WHERE user_id=requested_user;
 UPDATE refresh_sessions SET revoked_at=now() WHERE user_id=requested_user AND revoked_at IS NULL;
 UPDATE identity_sessions SET revoked_at=now() WHERE user_id=requested_user AND revoked_at IS NULL;
END $$;
REVOKE ALL ON FUNCTION rastreia.revoke_identity_credentials(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.revoke_identity_credentials(uuid) TO rastreia_runtime;
