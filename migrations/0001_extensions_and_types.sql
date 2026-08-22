CREATE SCHEMA IF NOT EXISTS rastreia;
SET LOCAL search_path TO rastreia, public;

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE TYPE tenant_status AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');
CREATE TYPE user_status AS ENUM ('ACTIVE', 'INVITED', 'BLOCKED', 'ARCHIVED');
CREATE TYPE tenant_role AS ENUM ('TENANT_MANAGER', 'STORE_OPERATOR', 'COURIER');
CREATE TYPE store_status AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE courier_status AS ENUM ('PENDING', 'ACTIVE', 'BLOCKED', 'INACTIVE');
CREATE TYPE courier_link_status AS ENUM ('PENDING', 'ACTIVE', 'BLOCKED', 'ENDED');
CREATE TYPE vehicle_type AS ENUM ('BICYCLE', 'MOTORCYCLE', 'CAR', 'VAN', 'ON_FOOT', 'OTHER');

CREATE OR REPLACE FUNCTION rastreia.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION rastreia.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION rastreia.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
