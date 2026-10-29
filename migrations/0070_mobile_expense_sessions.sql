SET LOCAL search_path TO rastreia, public;

-- This capability is accepted ONLY by /mobile-expenses, never by the general JWT guards.
-- No time-based expiry: explicit logout and credential/account changes revoke it.
CREATE TABLE mobile_expense_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  credential_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX mobile_expense_sessions_user_idx ON mobile_expense_sessions(user_id) WHERE revoked_at IS NULL;
ALTER TABLE mobile_expense_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_expense_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY mobile_expense_session_read ON mobile_expense_sessions FOR SELECT USING (
  user_id = current_user_id() OR token_hash = nullif(current_setting('app.expense_hash', true), '')
);
CREATE POLICY mobile_expense_session_insert ON mobile_expense_sessions FOR INSERT WITH CHECK (user_id = current_user_id());
CREATE POLICY mobile_expense_session_revoke ON mobile_expense_sessions FOR UPDATE USING (
  user_id = current_user_id() OR token_hash = nullif(current_setting('app.expense_hash', true), '')
) WITH CHECK (user_id = current_user_id() OR token_hash = nullif(current_setting('app.expense_hash', true), ''));
GRANT SELECT, INSERT ON mobile_expense_sessions TO rastreia_runtime;
GRANT UPDATE (revoked_at) ON mobile_expense_sessions TO rastreia_runtime;

CREATE FUNCTION rastreia.revoke_mobile_expense_credentials() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = rastreia, public, pg_temp AS $$
DECLARE prior_user text := current_setting('app.user_id', true);
BEGIN
  -- FORCE RLS also applies to a non-BYPASSRLS function owner. Scope narrowly to
  -- the changed row even when the change was made by the platform administrator.
  PERFORM set_config('app.user_id', NEW.id::text, true);
  UPDATE mobile_expense_sessions SET revoked_at = now() WHERE user_id = NEW.id AND revoked_at IS NULL;
  PERFORM set_config('app.user_id', coalesce(prior_user, ''), true);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rastreia.revoke_mobile_expense_credentials() FROM PUBLIC;
CREATE TRIGGER revoke_mobile_expense_credentials AFTER UPDATE OF password_hash, status, must_change_password, email_verified_at ON users
FOR EACH ROW WHEN (OLD.password_hash IS DISTINCT FROM NEW.password_hash OR OLD.status IS DISTINCT FROM NEW.status
  OR OLD.must_change_password IS DISTINCT FROM NEW.must_change_password OR OLD.email_verified_at IS DISTINCT FROM NEW.email_verified_at)
EXECUTE PROCEDURE rastreia.revoke_mobile_expense_credentials();
