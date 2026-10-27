SET LOCAL search_path TO rastreia, public;
ALTER TABLE company_service_settings DROP CONSTRAINT company_service_settings_provider_check;
ALTER TABLE company_service_settings ADD CONSTRAINT company_service_settings_provider_check
 CHECK(provider IN ('WEB_PUSH','WHATSAPP','SMS','IFOOD','BTG'));
ALTER TABLE company_service_settings ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE btg_authorizations ADD COLUMN settings_version integer NOT NULL DEFAULT 0;
GRANT UPDATE(version) ON company_service_settings TO rastreia_runtime;
GRANT UPDATE(settings_version) ON btg_authorizations TO rastreia_runtime;
-- No global credential is copied to companies. Existing authorizations remain pending,
-- with version 0, and cannot match a newly configured company integration.
