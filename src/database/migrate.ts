import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from './pool.js';

loadLocalEnv();
const env = getEnv();
const database = createPool(env);
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(currentDirectory, '../../migrations');

try {
  await database.query('CREATE SCHEMA IF NOT EXISTS rastreia');
  await database.query(`
    CREATE TABLE IF NOT EXISTS rastreia.schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDirectory))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();

  for (const file of files) {
    const applied = await database.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM rastreia.schema_migrations WHERE name = $1) AS exists',
      [file],
    );
    if (applied.rows[0]?.exists) continue;

    const sql = await readFile(resolve(migrationsDirectory, file), 'utf8');
    await withTransaction(database, async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO rastreia.schema_migrations (name) VALUES ($1)', [file]);
    });
    process.stdout.write(`aplicada: ${file}\n`);
  }
} finally {
  await database.end();
}
