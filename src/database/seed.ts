import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, setTenantContext, withTransaction } from './pool.js';

loadLocalEnv();
const env = getEnv();
const required = [
  env.BOOTSTRAP_TENANT_SLUG,
  env.BOOTSTRAP_TENANT_NAME,
  env.BOOTSTRAP_ADMIN_NAME,
  env.BOOTSTRAP_ADMIN_EMAIL,
  env.BOOTSTRAP_ADMIN_PASSWORD,
];

if (required.some((value) => !value)) {
  throw new Error('Preencha todas as variáveis BOOTSTRAP_* antes de executar o seed.');
}

const database = createPool(env);
try {
  const existing = await database.query<{ id: string }>(
    'SELECT id FROM rastreia.resolve_tenant_slug($1)',
    [env.BOOTSTRAP_TENANT_SLUG],
  );
  if (existing.rowCount) {
    process.stdout.write('Tenant bootstrap já existe; nenhuma alteração aplicada.\n');
    process.exitCode = 0;
  } else {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const passwordHash = await argon2.hash(env.BOOTSTRAP_ADMIN_PASSWORD!, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    await withTransaction(database, async (client) => {
      await setTenantContext(client, { tenantId, userId });
      await client.query(
        `INSERT INTO tenants (id, slug, name)
         VALUES ($1, $2, $3)`,
        [tenantId, env.BOOTSTRAP_TENANT_SLUG, env.BOOTSTRAP_TENANT_NAME],
      );
      await client.query(
        `INSERT INTO users (id, name, email, password_hash)
         VALUES ($1, $2, $3, $4)`,
        [userId, env.BOOTSTRAP_ADMIN_NAME, env.BOOTSTRAP_ADMIN_EMAIL, passwordHash],
      );
      await client.query(
        `INSERT INTO tenant_users (tenant_id, user_id, role, created_by, updated_by)
         VALUES ($1, $2, 'TENANT_MANAGER', $2, $2)`,
        [tenantId, userId],
      );
      await client.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after_data)
         VALUES ($1, $2, 'tenant.bootstrap', 'tenant', $1, jsonb_build_object('slug', $3::text))`,
        [tenantId, userId, env.BOOTSTRAP_TENANT_SLUG],
      );
    });
    process.stdout.write(`Tenant ${env.BOOTSTRAP_TENANT_SLUG} criado com gestor ${env.BOOTSTRAP_ADMIN_EMAIL}.\n`);
  }
} finally {
  await database.end();
}
