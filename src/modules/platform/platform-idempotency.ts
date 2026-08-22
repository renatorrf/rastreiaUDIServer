import type { PoolClient } from 'pg';
import type { PlatformAuthContext } from '../auth/auth.types.js';
import { requestHash, type IdempotentResult } from '../../shared/idempotency.js';
import { conflict } from '../../shared/errors.js';

export async function withPlatformIdempotency<T>(
  client: PoolClient,
  auth: PlatformAuthContext,
  key: string,
  operation: string,
  payload: unknown,
  execute: () => Promise<{ body: T; statusCode: number }>,
): Promise<IdempotentResult<T>> {
  const hash = requestHash(payload);
  await client.query(
    `INSERT INTO platform_idempotency_keys
       (platform_admin_id, idempotency_key, operation, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (platform_admin_id, idempotency_key, operation) DO NOTHING`,
    [auth.userId, key, operation, hash],
  );
  const storedResult = await client.query<{
    request_hash: string; response_status: number | null; response_body: T | null;
  }>(
    `SELECT request_hash, response_status, response_body FROM platform_idempotency_keys
     WHERE platform_admin_id = $1 AND idempotency_key = $2 AND operation = $3 FOR UPDATE`,
    [auth.userId, key, operation],
  );
  const stored = storedResult.rows[0]!;
  if (stored.request_hash !== hash) throw conflict('A chave de idempotência já foi usada com outra requisição.');
  if (stored.response_status !== null && stored.response_body !== null) {
    return { body: stored.response_body, statusCode: stored.response_status, replayed: true };
  }
  const result = await execute();
  await client.query(
    `UPDATE platform_idempotency_keys SET response_status = $4, response_body = $5::jsonb
     WHERE platform_admin_id = $1 AND idempotency_key = $2 AND operation = $3`,
    [auth.userId, key, operation, result.statusCode, JSON.stringify(result.body)],
  );
  return { ...result, replayed: false };
}
