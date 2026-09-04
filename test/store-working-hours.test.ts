import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { AuthContext } from '../src/modules/auth/auth.types.js';
import {
  canManageStoreWorkingHours, storeWorkingHoursSchema,
} from '../src/modules/stores/store.routes.js';

const storeId = '10000000-0000-4000-8000-000000000001';

function auth(role: AuthContext['role'], storeIds: string[] = []): AuthContext {
  return {
    tenantId: '20000000-0000-4000-8000-000000000001',
    userId: '30000000-0000-4000-8000-000000000001',
    sessionId: '40000000-0000-4000-8000-000000000001',
    role,
    storeIds,
  };
}

describe('store working-hours autonomy', () => {
  it('accepts complete weekly hours and overnight shifts', () => {
    expect(storeWorkingHoursSchema.parse({
      openingTime: '18:00',
      closingTime: '02:00',
      operatingWeekdays: [1, 2, 3, 4, 5],
      updatedAt: '2026-09-04T12:00:00.000Z',
    })).toMatchObject({ openingTime: '18:00', closingTime: '02:00' });
  });

  it('rejects incomplete or equal hours', () => {
    expect(storeWorkingHoursSchema.safeParse({
      openingTime: '08:00', closingTime: null, operatingWeekdays: [1],
      updatedAt: '2026-09-04T12:00:00.000Z',
    }).success).toBe(false);
    expect(storeWorkingHoursSchema.safeParse({
      openingTime: '08:00', closingTime: '08:00', operatingWeekdays: [1],
      updatedAt: '2026-09-04T12:00:00.000Z',
    }).success).toBe(false);
  });

  it('limits operators to linked stores and never grants couriers access', () => {
    expect(canManageStoreWorkingHours(auth('TENANT_MANAGER'), storeId)).toBe(true);
    expect(canManageStoreWorkingHours(auth('STORE_OPERATOR', [storeId]), storeId)).toBe(true);
    expect(canManageStoreWorkingHours(auth('STORE_OPERATOR'), storeId)).toBe(false);
    expect(canManageStoreWorkingHours(auth('COURIER', [storeId]), storeId)).toBe(false);
  });

  it('matches the database version after JSON removes timestamp microseconds', async () => {
    const database = new PGlite();
    try {
      await database.exec(`CREATE TABLE stores(id uuid PRIMARY KEY, updated_at timestamptz NOT NULL);
        INSERT INTO stores(id, updated_at)
        VALUES('${storeId}', '2026-09-04T12:00:00.123456Z')`);
      const result = await database.query(
        `UPDATE stores SET updated_at = now()
          WHERE id = $1
            AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $2::timestamptz)`,
        [storeId, '2026-09-04T12:00:00.123Z'],
      );
      expect(result.affectedRows).toBe(1);
    } finally {
      await database.close();
    }
  });

  it('allows scoped management to change only the operating schedule', async () => {
    const database = new PGlite();
    const tenantId = '20000000-0000-4000-8000-000000000001';
    const userId = '30000000-0000-4000-8000-000000000001';
    try {
      await database.exec(`CREATE SCHEMA rastreia; SET search_path=rastreia,public; CREATE ROLE rastreia_runtime;
        CREATE TABLE users(id uuid PRIMARY KEY,status text,email_verified_at timestamptz);
        CREATE TABLE tenant_users(tenant_id uuid,user_id uuid,role text,status text);
        CREATE TABLE stores(id uuid PRIMARY KEY,tenant_id uuid,name text,external_reference text,address_line text,
          address_number text,complement text,neighborhood text,city text,state text,postal_code text,latitude numeric,
          longitude numeric,address_confidence numeric,contact_phone text,status text,created_by uuid,updated_by uuid,
          created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),plan_code text,
          operational_limits jsonb,operational_settings jsonb,company_id uuid,opening_time time,closing_time time,
          operating_weekdays integer[]);
        CREATE FUNCTION current_user_id() RETURNS uuid LANGUAGE sql STABLE AS
          $$ SELECT NULLIF(current_setting('app.user_id',true),'')::uuid $$;
        CREATE FUNCTION is_master() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
        CREATE FUNCTION store_in_scope(requested uuid) RETURNS boolean LANGUAGE sql STABLE AS
          $$ SELECT requested='${storeId}'::uuid $$;
        CREATE FUNCTION guard_master_unit_write() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RAISE EXCEPTION 'MASTER_REQUIRED'; END $$;
        CREATE TRIGGER stores_master_only BEFORE INSERT OR UPDATE ON stores
          FOR EACH ROW EXECUTE PROCEDURE guard_master_unit_write();
        GRANT USAGE ON SCHEMA rastreia TO rastreia_runtime;
        GRANT SELECT,UPDATE ON users,tenant_users,stores TO rastreia_runtime;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rastreia TO rastreia_runtime;
        ALTER TABLE stores DISABLE TRIGGER stores_master_only;
        INSERT INTO users VALUES('${userId}','ACTIVE',now());
        INSERT INTO tenant_users VALUES('${tenantId}','${userId}','STORE_OPERATOR','ACTIVE');
        INSERT INTO stores(id,tenant_id,name,opening_time,closing_time,operating_weekdays)
          VALUES('${storeId}','${tenantId}','Loja teste','08:00','18:00',ARRAY[1,2,3,4,5]);
        ALTER TABLE stores ENABLE TRIGGER stores_master_only;`);
      await database.exec(await readFile(new URL('../migrations/0040_store_working_hours_autonomy.sql', import.meta.url), 'utf8'));
      await database.exec(`BEGIN; SET LOCAL search_path=rastreia,public; SET LOCAL ROLE rastreia_runtime;
        SELECT set_config('app.user_id','${userId}',true);`);

      const allowed = await database.query(
        'UPDATE stores SET opening_time=$2,closing_time=$3,operating_weekdays=$4,updated_at=now() WHERE id=$1',
        [storeId, '09:00', '19:00', [1, 2, 3, 4, 5, 6]],
      );
      expect(allowed.affectedRows).toBe(1);
      await expect(database.query('UPDATE stores SET name=$2 WHERE id=$1', [storeId, 'Nome alterado']))
        .rejects.toThrow(/MASTER_REQUIRED/);
      await database.exec('ROLLBACK');
    } finally {
      await database.close();
    }
  });
});
