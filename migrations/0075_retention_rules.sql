SET LOCAL search_path TO rastreia,public;
CREATE TABLE commerce_retention_rules (
 store_id uuid PRIMARY KEY REFERENCES stores(id), inactive_days integer NOT NULL CHECK(inactive_days BETWEEN 1 AND 365),
 min_orders integer NOT NULL CHECK(min_orders BETWEEN 1 AND 100), benefit text NOT NULL CHECK(benefit IN ('DISCOUNT','GIFT')),
 discount_percent integer CHECK(discount_percent BETWEEN 1 AND 100), valid_days integer NOT NULL CHECK(valid_days BETWEEN 1 AND 30),
 updated_at timestamptz NOT NULL DEFAULT now(), CHECK((benefit='DISCOUNT')=(discount_percent IS NOT NULL))
);
ALTER TABLE commerce_retention_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_retention_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY retention_manager ON commerce_retention_rules USING(commerce_manage_store(store_id)) WITH CHECK(commerce_manage_store(store_id));
GRANT SELECT,INSERT,UPDATE ON commerce_retention_rules TO rastreia_runtime;
