import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool } from './pool.js';

loadLocalEnv();
const database = createPool(getEnv());

try {
  const version = await database.query<{ server_version: string }>('SHOW server_version');
  const role = await database.query<{ is_superuser: boolean }>(
    `SELECT role.rolsuper AS is_superuser FROM pg_roles role WHERE role.rolname = current_user`,
  );
  const runtimeRole = await database.query<{
    exists: boolean;
    is_superuser: boolean | null;
    can_login: boolean | null;
  }>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rastreia_runtime') AS exists,
            (SELECT rolsuper FROM pg_roles WHERE rolname = 'rastreia_runtime') AS is_superuser,
            (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rastreia_runtime') AS can_login`,
  );
  const extensions = await database.query<{
    name: string;
    default_version: string;
    installed_version: string | null;
  }>(
    `SELECT name, default_version, installed_version
     FROM pg_available_extensions
     WHERE name IN ('postgis', 'citext', 'pgcrypto')
     ORDER BY name`,
  );
  const schema = await database.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.schemata WHERE schema_name = 'rastreia'
     ) AS exists`,
  );
  const migrations = await database.query<{ name: string }>(
    'SELECT name FROM rastreia.schema_migrations ORDER BY name',
  );
  const tables = await database.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'rastreia' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  const rls = await database.query<{ table_name: string; enabled: boolean; forced: boolean }>(
    `SELECT class.relname AS table_name,
            class.relrowsecurity AS enabled,
            class.relforcerowsecurity AS forced
     FROM pg_class class
     JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
     WHERE namespace.nspname = 'rastreia' AND class.relkind = 'r'
       AND class.relrowsecurity
     ORDER BY class.relname`,
  );

  process.stdout.write(`${JSON.stringify({
    serverVersion: version.rows[0]?.server_version,
    runtimeRoleIsSuperuser: role.rows[0]?.is_superuser ?? false,
    apiRole: runtimeRole.rows[0],
    extensions: extensions.rows,
    schemaExists: schema.rows[0]?.exists ?? false,
    migrations: migrations.rows.map((row) => row.name),
    tables: tables.rows.map((row) => row.table_name),
    rls: rls.rows,
  }, null, 2)}\n`);
} finally {
  await database.end();
}
