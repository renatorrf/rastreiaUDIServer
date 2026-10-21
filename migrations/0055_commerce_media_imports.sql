SET LOCAL search_path TO rastreia, public;
ALTER TABLE commerce_products ADD COLUMN barcode text CHECK(barcode IS NULL OR barcode ~ '^[0-9]{8,14}$');
ALTER TABLE commerce_products ADD COLUMN media_version integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX commerce_products_barcode ON commerce_products(store_id,barcode) WHERE barcode IS NOT NULL;
CREATE TABLE commerce_product_images (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, store_id uuid NOT NULL, product_id uuid NOT NULL,
 object_key text NOT NULL, thumbnail_key text NOT NULL, checksum text NOT NULL,
 alt text NOT NULL CHECK(char_length(alt)<=160), width integer NOT NULL, height integer NOT NULL,
 bytes integer NOT NULL, position integer NOT NULL DEFAULT 0, archived boolean NOT NULL DEFAULT false,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(product_id,tenant_id,store_id) REFERENCES commerce_products(id,tenant_id,store_id)
);
CREATE INDEX commerce_images_product ON commerce_product_images(product_id,archived,position,id);
ALTER TABLE commerce_product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_product_images FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_images_manager ON commerce_product_images USING(tenant_id=current_tenant_id() AND commerce_manage_store(store_id)) WITH CHECK(tenant_id=current_tenant_id() AND commerce_manage_store(store_id));
GRANT SELECT,INSERT ON commerce_product_images TO rastreia_runtime;
GRANT UPDATE(alt,position,archived) ON commerce_product_images TO rastreia_runtime;

CREATE TABLE commerce_import_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 file_name text NOT NULL,file_hash text NOT NULL, source jsonb NOT NULL CHECK(octet_length(source::text)<=2097152),
 state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','PREVIEW','APPLIED')),
 preview jsonb,options jsonb,preview_token uuid,preview_expires_at timestamptz,result jsonb,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),applied_at timestamptz,
 UNIQUE(store_id,file_hash),FOREIGN KEY(store_id,tenant_id) REFERENCES stores(id,tenant_id)
);
ALTER TABLE commerce_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_import_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_imports_manager ON commerce_import_jobs USING(tenant_id=current_tenant_id() AND commerce_manage_store(store_id)) WITH CHECK(tenant_id=current_tenant_id() AND commerce_manage_store(store_id));
GRANT SELECT,INSERT ON commerce_import_jobs TO rastreia_runtime;
GRANT UPDATE(state,preview,options,preview_token,preview_expires_at,result,applied_at) ON commerce_import_jobs TO rastreia_runtime;

-- Keep the existing bounded public projection, adding only safe image metadata.
ALTER FUNCTION commerce_public_products(text,text,uuid,integer,integer) RENAME TO commerce_public_products_without_images;
REVOKE ALL ON FUNCTION commerce_public_products_without_images(text,text,uuid,integer,integer) FROM rastreia_runtime;
CREATE FUNCTION commerce_public_products(requested_slug text,query_text text,requested_category uuid,page_limit integer,page_offset integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 WITH base AS (SELECT commerce_public_products_without_images(requested_slug,query_text,requested_category,page_limit,page_offset) AS data)
 SELECT jsonb_set(base.data,'{data}',coalesce((SELECT jsonb_agg(item.value || jsonb_build_object('images',coalesce((
  SELECT jsonb_agg(jsonb_build_object('id',i.id,'alt',i.alt) ORDER BY i.position,i.id) FROM commerce_product_images i
  WHERE i.product_id=(item.value->>'id')::uuid AND NOT i.archived),'[]'::jsonb)) ORDER BY item.ordinality)
  FROM jsonb_array_elements(base.data->'data') WITH ORDINALITY AS item(value,ordinality)),'[]'::jsonb)) FROM base
$$;
CREATE FUNCTION commerce_public_image(requested_slug text,image_id uuid,thumbnail boolean) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 SELECT CASE WHEN thumbnail THEN i.thumbnail_key ELSE i.object_key END FROM commerce_product_images i
 JOIN commerce_products p ON p.id=i.product_id AND p.store_id=i.store_id AND p.tenant_id=i.tenant_id
 JOIN commerce_storefronts f ON f.store_id=p.store_id AND f.tenant_id=p.tenant_id
 LEFT JOIN commerce_categories c ON c.id=p.category_id
 WHERE i.id=image_id AND NOT i.archived AND f.slug=requested_slug AND commerce_public_store(requested_slug) IS NOT NULL
 AND p.active AND p.published AND (c.id IS NULL OR c.active) AND EXISTS(SELECT 1 FROM commerce_variants v WHERE v.product_id=p.id AND v.active)
$$;
REVOKE ALL ON FUNCTION commerce_public_products(text,text,uuid,integer,integer),commerce_public_image(text,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_public_products(text,text,uuid,integer,integer),commerce_public_image(text,uuid,boolean) TO rastreia_runtime;
