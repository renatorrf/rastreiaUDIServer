import { setTenantContext, withPlatformTransaction, type Database } from '../../database/pool.js';
import { conflict, notFound } from '../../shared/errors.js';
import type { PlatformAuthContext } from '../auth/auth.types.js';
import { withPlatformIdempotency } from './platform-idempotency.js';

type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

interface ListInput { search?: string | undefined; status?: TenantStatus | undefined; limit: number; offset: number }

async function writePlatformAudit(client: import('pg').PoolClient, input: {
  actorId: string; action: string; entityId: string; targetTenantId: string;
  beforeData?: unknown; afterData?: unknown; reason?: string | undefined; ip?: string | undefined;
}) {
  await client.query(
    `INSERT INTO platform_audit_logs
       (actor_platform_admin_id, action, entity_type, entity_id, target_tenant_id,
        before_data, after_data, reason, ip)
     VALUES ($1, $2, 'tenant', $3, $4, $5::jsonb, $6::jsonb, $7, $8::inet)`,
    [input.actorId, input.action, input.entityId, input.targetTenantId,
      input.beforeData === undefined ? null : JSON.stringify(input.beforeData),
      input.afterData === undefined ? null : JSON.stringify(input.afterData),
      input.reason ?? null, input.ip ?? null],
  );
}

export async function listPlatformTenants(database: Database, auth: PlatformAuthContext, input: ListInput) {
  return withPlatformTransaction(database, auth, async (client) => {
    const values: unknown[] = [];
    const filters: string[] = [];
    if (input.status) { values.push(input.status); filters.push(`status = $${values.length}`); }
    if (input.search) {
      values.push(`%${input.search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
      filters.push(`(name ILIKE $${values.length} ESCAPE '\\' OR slug::text ILIKE $${values.length} ESCAPE '\\')`);
    }
    values.push(input.limit, input.offset);
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await client.query(
      `SELECT id, slug, name, legal_name AS "legalName", status, timezone,
              contact_phone AS "contactPhone", created_at AS "createdAt", updated_at AS "updatedAt",
              count(*) OVER()::integer AS "totalCount"
       FROM tenants ${where}
       ORDER BY created_at DESC, id
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { data: result.rows.map(({ totalCount: _totalCount, ...tenant }) => tenant),
      total: result.rows[0]?.totalCount ?? 0, limit: input.limit, offset: input.offset };
  });
}

export async function changePlatformTenantStatus(
  database: Database,
  auth: PlatformAuthContext,
  idempotencyKey: string,
  tenantId: string,
  status: TenantStatus,
  reason: string,
  ip?: string,
) {
  return withPlatformTransaction(database, auth, (client) => withPlatformIdempotency(
    client, auth, idempotencyKey, 'platform.tenant.status', { tenantId, status, reason }, async () => {
    const currentResult = await client.query<{ id: string; slug: string; name: string; status: TenantStatus }>(
      'SELECT id, slug, name, status FROM tenants WHERE id = $1 FOR UPDATE', [tenantId],
    );
    const current = currentResult.rows[0];
    if (!current) throw notFound('Empresa não encontrada.');
    if (current.status === 'ARCHIVED' && status !== 'ARCHIVED') {
      throw conflict('Empresa arquivada não pode ser reativada.');
    }
    const updatedResult = await client.query(
      `UPDATE tenants SET status = $2 WHERE id = $1
       RETURNING id, slug, name, legal_name AS "legalName", status, timezone,
                 contact_phone AS "contactPhone", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [tenantId, status],
    );
    if (status !== 'ACTIVE') {
      await setTenantContext(client, { tenantId, userId: auth.userId });
      await client.query(
        `UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, now())
         WHERE tenant_id = $1 AND revoked_at IS NULL`, [tenantId],
      );
    }
    await writePlatformAudit(client, {
      actorId: auth.userId, action: 'platform.tenant.status_changed', entityId: tenantId,
      targetTenantId: tenantId, beforeData: { status: current.status }, afterData: { status }, reason, ip,
    });
    return { body: updatedResult.rows[0], statusCode: 200 };
  }));
}

export async function listPlatformAudit(database: Database, auth: PlatformAuthContext, limit: number) {
  return withPlatformTransaction(database, auth, async (client) => {
    const result = await client.query(
      `SELECT audit.id, audit.action, audit.entity_type AS "entityType", audit.entity_id AS "entityId",
              audit.target_tenant_id AS "targetTenantId", tenant.name AS "tenantName",
              audit.before_data AS "beforeData", audit.after_data AS "afterData",
              audit.reason, audit.created_at AS "createdAt"
       FROM platform_audit_logs audit
       LEFT JOIN tenants tenant ON tenant.id = audit.target_tenant_id
       ORDER BY audit.created_at DESC LIMIT $1`, [limit],
    );
    return { data: result.rows };
  });
}
