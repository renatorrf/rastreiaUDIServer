SET search_path TO rastreia, public;

CREATE OR REPLACE FUNCTION reject_offer_financial_mutation() RETURNS trigger AS $$
BEGIN
  IF current_user = 'rastreia_runtime' THEN
    RAISE EXCEPTION 'offer financial entries are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
