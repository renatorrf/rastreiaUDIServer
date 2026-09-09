SET LOCAL search_path TO rastreia, public;

ALTER TABLE users
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

ALTER TABLE customer_profiles
  ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN qualification_data_encrypted text,
  ADD COLUMN profile_photo_object_key text,
  ADD COLUMN profile_photo_mime_type text,
  ADD COLUMN identity_document_object_key text,
  ADD COLUMN identity_document_mime_type text;

CREATE INDEX customer_profiles_user_idx ON customer_profiles (user_id)
  WHERE user_id IS NOT NULL;

CREATE POLICY customer_profiles_identity ON customer_profiles
  USING (user_id = rastreia.current_user_id())
  WITH CHECK (user_id = rastreia.current_user_id());

DROP FUNCTION rastreia.identity_by_email(text);
CREATE FUNCTION rastreia.identity_by_email(requested_email text)
RETURNS TABLE (
  id uuid, name text, email citext, password_hash text, status user_status,
  email_verified_at timestamptz, must_change_password boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
 SELECT id, name, email, password_hash, status, email_verified_at, must_change_password
 FROM users WHERE email = requested_email::citext LIMIT 1
$$;
REVOKE ALL ON FUNCTION rastreia.identity_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.identity_by_email(text) TO rastreia_runtime;

CREATE OR REPLACE FUNCTION rastreia.register_customer_identity(
  requested_profile uuid, requested_user uuid, requested_name text,
  requested_email text, requested_password_hash text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = rastreia, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM customer_profiles
    WHERE id = requested_profile
      AND tenant_id = rastreia.current_tenant_id()
      AND user_id IS NULL
  ) OR EXISTS (SELECT 1 FROM users WHERE email = requested_email::citext) THEN
    RETURN false;
  END IF;

  INSERT INTO users(id,name,email,password_hash,email_verified_at,must_change_password)
  VALUES(requested_user,requested_name,requested_email,requested_password_hash,now(),true);
  UPDATE customer_profiles SET user_id=requested_user WHERE id=requested_profile;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION rastreia.register_customer_identity(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rastreia.register_customer_identity(uuid,uuid,text,text,text) TO rastreia_runtime;

GRANT SELECT, UPDATE ON customer_profiles TO rastreia_runtime;
