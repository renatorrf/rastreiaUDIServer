import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AuthContext } from '../modules/auth/auth.types.js';
import { conflict } from './errors.js';

export interface IdempotentResult<T> {
  body: T;
  statusCode: number;
  replayed: boolean;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function parseIdempotencyKey(value: string | string[] | undefined): string {
  const key = Array.isArray(value) ? value[0] : value;
  if (!key || key.length < 8 || key.length > 100) {
    throw conflict('Envie um cabeçalho Idempotency-Key entre 8 e 100 caracteres.');
  }
  return key;
}

export async function withIdempotency<T>(
  client: PoolClient,
  auth: AuthContext,
  key: string,
  operation: string,
  payload: unknown,
  execute: () => Promise<{ body: T; statusCode: number }>,
): Promise<IdempotentResult<T>> {
  const hash = requestHash(payload);
  await client.query(
    `INSERT INTO idempotency_keys
       (tenant_id, idempotency_key, operation, actor_user_id, request_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, idempotency_key, operation) DO NOTHING`,
    [auth.tenantId, key, operation, auth.userId, hash],
  );

  const storedResult = await client.query<{
    actor_user_id: string;
    request_hash: string;
    response_status: number | null;
    response_body: T | null;
  }>(
    `SELECT actor_user_id, request_hash, response_status, response_body
     FROM idempotency_keys
     WHERE tenant_id = $1 AND idempotency_key = $2 AND operation = $3
     FOR UPDATE`,
    [auth.tenantId, key, operation],
  );
  const stored = storedResult.rows[0]!;
  if (stored.actor_user_id !== auth.userId || stored.request_hash !== hash) {
    throw conflict('A chave de idempotência já foi usada com outra requisição.');
  }
  if (stored.response_body !== null && stored.response_status !== null) {
    return { body: stored.response_body, statusCode: stored.response_status, replayed: true };
  }

  const result = await execute();
  await client.query(
    `UPDATE idempotency_keys
     SET response_status = $4, response_body = $5::jsonb
     WHERE tenant_id = $1 AND idempotency_key = $2 AND operation = $3`,
    [auth.tenantId, key, operation, result.statusCode, JSON.stringify(result.body)],
  );
  return { ...result, replayed: false };
}
