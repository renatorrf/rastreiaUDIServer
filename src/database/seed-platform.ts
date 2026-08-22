import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from './pool.js';

loadLocalEnv();
const env = getEnv();
const values = [
  env.BOOTSTRAP_PLATFORM_ADMIN_NAME,
  env.BOOTSTRAP_PLATFORM_ADMIN_EMAIL,
  env.BOOTSTRAP_PLATFORM_ADMIN_PASSWORD,
];
if (values.some(Boolean) && !values.every(Boolean)) {
  throw new Error('Preencha todas as variáveis BOOTSTRAP_PLATFORM_ADMIN_* antes de executar o seed.');
}
if (!values.every(Boolean)) throw new Error('As variáveis BOOTSTRAP_PLATFORM_ADMIN_* estão ausentes.');

const database = createPool(env);
try {
  const existing = await database.query<{ id: string }>(
    'SELECT id FROM rastreia.resolve_platform_admin_email($1)', [env.BOOTSTRAP_PLATFORM_ADMIN_EMAIL],
  );
  if (existing.rowCount) {
    process.stdout.write('Administrador da plataforma já existe; nenhuma alteração aplicada.\n');
  } else {
    const id = randomUUID();
    const passwordHash = await argon2.hash(env.BOOTSTRAP_PLATFORM_ADMIN_PASSWORD!, {
      type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1,
    });
    await withTransaction(database, async (client) => {
      await client.query("SELECT set_config('app.platform_admin_id', $1, true)", [id]);
      await client.query(
        `INSERT INTO platform_admins (id, name, email, password_hash)
         VALUES ($1, $2, $3, $4)`,
        [id, env.BOOTSTRAP_PLATFORM_ADMIN_NAME, env.BOOTSTRAP_PLATFORM_ADMIN_EMAIL, passwordHash],
      );
    });
    process.stdout.write(`Administrador da plataforma ${env.BOOTSTRAP_PLATFORM_ADMIN_EMAIL} criado.\n`);
  }
} finally {
  await database.end();
}
