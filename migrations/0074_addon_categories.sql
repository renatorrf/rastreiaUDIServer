SET LOCAL search_path TO rastreia,public;
ALTER TABLE commerce_categories ADD COLUMN is_addon boolean NOT NULL DEFAULT false,
 ADD COLUMN addons jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(addons)='array' AND jsonb_array_length(addons)<=4 AND (is_addon OR addons='[]'));
ALTER TABLE commerce_products ADD COLUMN addon_category_id uuid,
 ADD FOREIGN KEY(addon_category_id,tenant_id,store_id) REFERENCES commerce_categories(id,tenant_id,store_id);
CREATE INDEX commerce_products_addon_category_idx ON commerce_products(addon_category_id) WHERE addon_category_id IS NOT NULL;
CREATE FUNCTION commerce_check_catalog_category() RETURNS trigger LANGUAGE plpgsql SET search_path=rastreia,public,pg_temp AS $$
BEGIN
 IF (SELECT is_addon FROM commerce_categories WHERE id=NEW.category_id FOR SHARE) THEN
   RAISE EXCEPTION 'Categoria de adicionais não é categoria de vitrine' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commerce_catalog_category BEFORE INSERT OR UPDATE OF category_id ON commerce_products FOR EACH ROW EXECUTE PROCEDURE commerce_check_catalog_category();
