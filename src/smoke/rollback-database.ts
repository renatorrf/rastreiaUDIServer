import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database/pool.js';

/** A single outer transaction keeps integration fixtures and trial DDL recoverable.
 * Requests use serialized savepoints: this tests replay, NOT cross-connection races.
 * Only the promise-based pg API used by this application is supported.
 */
export function rollbackDatabase(pool: Database, connection: PoolClient): Database {
  let queue = Promise.resolve();
  let sequence = 0;
  const acquire = async () => {
    const previous = queue;
    let unlock = () => {};
    queue = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    return unlock;
  };
  const resetContext = async () => {
    await connection.query('SET LOCAL ROLE NONE');
    await connection.query(`SELECT set_config(key,'',true) FROM unnest(ARRAY[
      'app.tenant_id','app.user_id','app.store_ids','app.platform_admin_id','app.tracking_hash']) key`);
  };
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'end') return async () => {};
      if (property === 'query') return async <R extends QueryResultRow>(sql: string, values?: unknown[]) => {
        const unlock = await acquire();
        try { return await connection.query<R>(sql, values); } finally { unlock(); }
      };
      if (property === 'connect') return async () => {
        const unlock = await acquire();
        const savepoint = `revision_request_${++sequence}`;
        return new Proxy(connection, {
          get(client, key) {
            if (key === 'release') return unlock;
            if (key === 'query') return async <R extends QueryResultRow>(sql: string, values?: unknown[]) => {
              if (sql === 'BEGIN') return connection.query(`SAVEPOINT ${savepoint}`);
              if (sql === 'ROLLBACK') {
                await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
                await resetContext();
                return connection.query(`RELEASE SAVEPOINT ${savepoint}`);
              }
              if (sql === 'COMMIT') {
                await resetContext();
                return connection.query(`RELEASE SAVEPOINT ${savepoint}`);
              }
              return connection.query<R>(sql, values);
            };
            const value: unknown = Reflect.get(client, key);
            return typeof value === 'function' ? value.bind(client) : value;
          },
        });
      };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
