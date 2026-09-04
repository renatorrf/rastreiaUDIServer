SET LOCAL search_path TO rastreia, public;

-- The Master remains the only actor allowed to create units or change their
-- identity, address and status. Tenant management may update only the weekly
-- operating schedule of a unit already inside its explicit scope.
CREATE OR REPLACE FUNCTION rastreia.guard_master_unit_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=rastreia,public,pg_temp AS $$
BEGIN
  IF current_user <> 'rastreia_runtime' OR rastreia.is_master() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND rastreia.store_in_scope(OLD.id)
     AND EXISTS (
       SELECT 1
         FROM tenant_users membership
         JOIN users account ON account.id = membership.user_id
        WHERE membership.tenant_id = OLD.tenant_id
          AND membership.user_id = rastreia.current_user_id()
          AND membership.role IN ('TENANT_MANAGER', 'STORE_OPERATOR')
          AND membership.status = 'ACTIVE'
          AND account.status = 'ACTIVE'
          AND account.email_verified_at IS NOT NULL
     )
     AND ROW(
       NEW.id, NEW.tenant_id, NEW.name, NEW.external_reference, NEW.address_line, NEW.address_number,
       NEW.complement, NEW.neighborhood, NEW.city, NEW.state, NEW.postal_code, NEW.latitude, NEW.longitude,
       NEW.address_confidence, NEW.contact_phone, NEW.status, NEW.created_by, NEW.updated_by, NEW.created_at,
       NEW.plan_code, NEW.operational_limits, NEW.operational_settings, NEW.company_id
     ) IS NOT DISTINCT FROM ROW(
       OLD.id, OLD.tenant_id, OLD.name, OLD.external_reference, OLD.address_line, OLD.address_number,
       OLD.complement, OLD.neighborhood, OLD.city, OLD.state, OLD.postal_code, OLD.latitude, OLD.longitude,
       OLD.address_confidence, OLD.contact_phone, OLD.status, OLD.created_by, OLD.updated_by, OLD.created_at,
       OLD.plan_code, OLD.operational_limits, OLD.operational_settings, OLD.company_id
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'MASTER_REQUIRED' USING ERRCODE='P0001';
END $$;
