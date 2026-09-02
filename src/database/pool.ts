import pg from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import type { AppEnv } from '../config/env.js';
import type { PlatformAuthContext } from '../modules/auth/auth.types.js';

const { Pool } = pg;
const runtimeRole = 'rastreia_runtime';

export type Database = InstanceType<typeof Pool>;

export interface TenantContext {
  tenantId: string;
  userId: string;
  storeIds?: string[];
}

export function createPool(env: AppEnv): Database {
  return new Pool({
    connectionString: env.DATABASE_URL,
    options: '-c search_path=rastreia,public',
    max: env.NODE_ENV === 'test' ? 2 : 10,
    application_name: 'rastreia-backend',
    ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : undefined,
  });
}

export async function withTransaction<T>(
  database: Database,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function assumeRuntimeRole(client: PoolClient): Promise<void> {
  // This is a fixed identifier created by migration 0005. Keeping it out of
  // configuration prevents an environment value from becoming executable SQL.
  await client.query(`SET LOCAL ROLE ${runtimeRole}`);
}

export async function withRuntimeTransaction<T>(
  database: Database,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(database, async (client) => {
    await assumeRuntimeRole(client);
    return callback(client);
  });
}

export async function setTenantContext(client: PoolClient, context: TenantContext): Promise<void> {
  await client.query(
    `SELECT
       set_config('app.tenant_id', $1, true),
       set_config('app.user_id', $2, true),
       set_config('app.store_ids', $3, true)`,
    [context.tenantId, context.userId, context.storeIds ? JSON.stringify(context.storeIds) : ''],
  );
}

export async function setPlatformContext(client: PoolClient, context: PlatformAuthContext): Promise<void> {
  await client.query("SELECT set_config('app.platform_admin_id', $1, true)", [context.userId]);
}

export async function withPlatformTransaction<T>(
  database: Database,
  context: PlatformAuthContext,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(database, async (client) => {
    await assumeRuntimeRole(client);
    await setPlatformContext(client, context);
    return callback(client);
  });
}

export async function withTenantTransaction<T>(
  database: Database,
  context: TenantContext,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(database, async (client) => {
    await assumeRuntimeRole(client);
    await setTenantContext(client, context);
    return callback(client);
  });
}

export function firstRow<T extends QueryResultRow>(rows: T[]): T | undefined {
  return rows[0];
}
