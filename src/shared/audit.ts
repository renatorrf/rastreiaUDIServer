import type { PoolClient } from 'pg';

interface AuditInput {
  tenantId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string;
  beforeData?: unknown;
  afterData?: unknown;
  ip?: string;
}

export async function writeAudit(client: PoolClient, input: AuditInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs
       (tenant_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, ip)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::inet)`,
    [
      input.tenantId,
      input.actorUserId,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.beforeData === undefined ? null : JSON.stringify(input.beforeData),
      input.afterData === undefined ? null : JSON.stringify(input.afterData),
      input.ip ?? null,
    ],
  );
}
