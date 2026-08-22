import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withTenantTransaction, type Database } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, notFound } from '../../shared/errors.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';

const staffRoles = ['TENANT_MANAGER', 'STORE_OPERATOR'] as const;
const membershipStatuses = ['ACTIVE', 'BLOCKED', 'ARCHIVED'] as const;

const createUserSchema = z.object({
  name: z.string().trim().min(2).max(160),
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(12).max(200),
  role: z.enum(staffRoles),
  storeIds: z.array(z.string().uuid()).max(100).default([]),
});

const linkUserSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  role: z.enum(staffRoles),
  storeIds: z.array(z.string().uuid()).max(100).default([]),
});

const updateUserSchema = z.object({
  role: z.enum(staffRoles),
  status: z.enum(membershipStatuses),
  storeIds: z.array(z.string().uuid()).max(100).default([]),
  reason: z.string().trim().min(4).max(500),
});

const resetPasswordSchema = z.object({
  password: z.string().min(12).max(200),
  reason: z.string().trim().min(4).max(500),
});

async function validateStores(client: PoolClient, storeIds: string[]): Promise<void> {
  if (!storeIds.length) return;
  const stores = await client.query<{ id: string }>('SELECT id FROM stores WHERE id = ANY($1::uuid[])', [storeIds]);
  if (stores.rowCount !== new Set(storeIds).size) throw conflict('Uma ou mais lojas não pertencem à empresa.');
}

async function replaceStoreAccess(
  client: PoolClient,
  tenantId: string,
  membershipId: string,
  storeIds: string[],
  actorUserId: string,
): Promise<void> {
  await client.query('DELETE FROM user_store_access WHERE tenant_user_id = $1', [membershipId]);
  for (const storeId of [...new Set(storeIds)]) {
    await client.query(
      `INSERT INTO user_store_access (tenant_id, tenant_user_id, store_id, created_by)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, membershipId, storeId, actorUserId],
    );
  }
}

export async function userRoutes(app: FastifyInstance, database: Database, env: AppEnv): Promise<void> {
  const auth = authenticate(env, database);

  app.get('/users', { preHandler: [auth, requireRoles('TENANT_MANAGER')] }, async (request) =>
    withTenantTransaction(database, request.auth, async (client) => {
      const result = await client.query(
        `SELECT u.id, u.name, u.email, u.status AS "accountStatus", membership.role,
                membership.status AS "membershipStatus",
                COALESCE(array_agg(access.store_id) FILTER (WHERE access.store_id IS NOT NULL), '{}') AS "storeIds",
                membership.created_at AS "createdAt", membership.updated_at AS "updatedAt"
         FROM tenant_users membership
         JOIN users u ON u.id = membership.user_id
         LEFT JOIN user_store_access access ON access.tenant_user_id = membership.id
         WHERE membership.tenant_id = $1 AND membership.role <> 'COURIER'
         GROUP BY u.id, membership.id
         ORDER BY CASE membership.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, u.name`,
        [request.auth.tenantId],
      );
      return { data: result.rows };
    }),
  );

  app.get('/users/password-reset-requests', {
    preHandler: [auth, requireRoles('TENANT_MANAGER')],
  }, async (request) => withTenantTransaction(database, request.auth, async (client) => {
    const result = await client.query(
      `SELECT reset.id, reset.user_id AS "userId", account.name, account.email,
              membership.role, reset.requested_at AS "requestedAt"
       FROM password_reset_requests reset
       JOIN users account ON account.id = reset.user_id
       JOIN tenant_users membership
         ON membership.tenant_id = reset.tenant_id AND membership.user_id = reset.user_id
       WHERE reset.tenant_id = $1 AND reset.status = 'PENDING'
       ORDER BY reset.requested_at DESC`,
      [request.auth.tenantId],
    );
    return { data: result.rows };
  }));

  app.post('/users/:userId/password', {
    preHandler: [auth, requireRoles('TENANT_MANAGER')],
  }, async (request) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    const input = resetPasswordSchema.parse(request.body);
    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1,
    });
    return withTenantTransaction(database, request.auth, async (client) => {
      const target = await client.query<{ id: string; role: string; status: string }>(
        `SELECT id, role, status FROM tenant_users
         WHERE tenant_id = $1 AND user_id = $2`,
        [request.auth.tenantId, userId],
      );
      const membership = target.rows[0];
      if (!membership) throw notFound('Pessoa não encontrada nesta empresa.');
      if (membership.status !== 'ACTIVE') throw conflict('Ative o vínculo antes de redefinir a senha.');

      await client.query(
        `UPDATE tenant_users SET password_hash = $3, updated_by = $4
         WHERE tenant_id = $1 AND user_id = $2`,
        [request.auth.tenantId, userId, passwordHash, request.auth.userId],
      );
      const sessions = await client.query(
        `UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, now())
         WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [request.auth.tenantId, userId],
      );
      await client.query(
        `UPDATE password_reset_requests
         SET status = 'COMPLETED', completed_at = now(), completed_by = $3
         WHERE tenant_id = $1 AND user_id = $2 AND status = 'PENDING'`,
        [request.auth.tenantId, userId, request.auth.userId],
      );
      await writeAudit(client, {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'user.password_reset', entityType: 'tenant_user', entityId: membership.id,
        afterData: { reason: input.reason, sessionsRevoked: sessions.rowCount ?? 0 }, ip: request.ip,
      });
      return { userId, reset: true };
    });
  });

  app.post('/users', { preHandler: [auth, requireRoles('TENANT_MANAGER')] }, async (request, reply) => {
    const input = createUserSchema.parse(request.body);
    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1,
    });
    try {
      const created = await withTenantTransaction(database, request.auth, async (client) => {
        await validateStores(client, input.storeIds);
        const account = { id: randomUUID(), name: input.name, email: input.email };
        await client.query(
          'INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)',
          [account.id, account.name, account.email, passwordHash],
        );
        const membership = await client.query<{ id: string }>(
          `INSERT INTO tenant_users (tenant_id, user_id, role, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $4) RETURNING id`,
          [request.auth.tenantId, account.id, input.role, request.auth.userId],
        );
        await replaceStoreAccess(client, request.auth.tenantId, membership.rows[0]!.id, input.storeIds, request.auth.userId);
        const response = {
          ...account, role: input.role, accountStatus: 'ACTIVE', membershipStatus: 'ACTIVE', storeIds: input.storeIds,
        };
        await writeAudit(client, {
          tenantId: request.auth.tenantId, actorUserId: request.auth.userId, action: 'user.created',
          entityType: 'user', entityId: account.id, afterData: response, ip: request.ip,
        });
        return response;
      });
      return reply.status(201).send(created);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw conflict('Já existe uma conta com este e-mail. Use “Vincular conta existente”.');
      }
      throw error;
    }
  });

  app.post('/users/link', { preHandler: [auth, requireRoles('TENANT_MANAGER')] }, async (request, reply) => {
    const input = linkUserSchema.parse(request.body);
    const linked = await withTenantTransaction(database, request.auth, async (client) => {
      await validateStores(client, input.storeIds);
      const accountResult = await client.query<{
        id: string; name: string; email: string; status: string; courier_profile_id: string | null;
      }>('SELECT * FROM rastreia.resolve_user_email($1)', [input.email]);
      const account = accountResult.rows[0];
      if (!account || account.status !== 'ACTIVE') throw notFound('Conta ativa não encontrada para este e-mail.');
      const existing = await client.query('SELECT 1 FROM tenant_users WHERE tenant_id = $1 AND user_id = $2', [
        request.auth.tenantId, account.id,
      ]);
      if (existing.rowCount) throw conflict('Esta conta já está vinculada à empresa.');
      const membership = await client.query<{ id: string }>(
        `INSERT INTO tenant_users (tenant_id, user_id, role, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $4) RETURNING id`,
        [request.auth.tenantId, account.id, input.role, request.auth.userId],
      );
      await replaceStoreAccess(client, request.auth.tenantId, membership.rows[0]!.id, input.storeIds, request.auth.userId);
      const response = {
        id: account.id, name: account.name, email: account.email, role: input.role,
        accountStatus: account.status, membershipStatus: 'ACTIVE', storeIds: input.storeIds,
      };
      await writeAudit(client, {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId, action: 'user.linked',
        entityType: 'user', entityId: account.id, afterData: response, ip: request.ip,
      });
      return response;
    });
    return reply.status(201).send(linked);
  });

  app.patch('/users/:userId', { preHandler: [auth, requireRoles('TENANT_MANAGER')] }, async (request) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    const input = updateUserSchema.parse(request.body);
    if (userId === request.auth.userId) throw conflict('Use outro gestor para alterar o seu próprio vínculo.');
    return withTenantTransaction(database, request.auth, async (client) => {
      await validateStores(client, input.storeIds);
      const targetResult = await client.query<{
        id: string; role: 'TENANT_MANAGER' | 'STORE_OPERATOR'; status: string; store_ids: string[];
      }>(
        `SELECT membership.id, membership.role, membership.status,
                COALESCE(array_agg(access.store_id) FILTER (WHERE access.store_id IS NOT NULL), '{}') AS store_ids
         FROM tenant_users membership
         LEFT JOIN user_store_access access ON access.tenant_user_id = membership.id
         WHERE membership.tenant_id = $1 AND membership.user_id = $2 AND membership.role <> 'COURIER'
         GROUP BY membership.id`,
        [request.auth.tenantId, userId],
      );
      const target = targetResult.rows[0];
      if (!target) throw notFound('Usuário não encontrado nesta empresa.');
      if (target.role === 'TENANT_MANAGER' && (input.role !== 'TENANT_MANAGER' || input.status !== 'ACTIVE')) {
        const managers = await client.query<{ total: string }>(
          `SELECT count(*)::text AS total FROM tenant_users
           WHERE tenant_id = $1 AND role = 'TENANT_MANAGER' AND status = 'ACTIVE' AND user_id <> $2`,
          [request.auth.tenantId, userId],
        );
        if (managers.rows[0]?.total === '0') throw conflict('A empresa deve manter ao menos um gestor ativo.');
      }
      const before = { role: target.role, status: target.status, storeIds: target.store_ids };
      await client.query(
        `UPDATE tenant_users SET role = $3, status = $4, updated_by = $5
         WHERE tenant_id = $1 AND user_id = $2`,
        [request.auth.tenantId, userId, input.role, input.status, request.auth.userId],
      );
      await replaceStoreAccess(client, request.auth.tenantId, target.id, input.storeIds, request.auth.userId);
      await client.query(
        `UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, now())
         WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [request.auth.tenantId, userId],
      );
      const after = { role: input.role, status: input.status, storeIds: input.storeIds, reason: input.reason };
      await writeAudit(client, {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId, action: 'user.membership_updated',
        entityType: 'tenant_user', entityId: target.id, beforeData: before, afterData: after, ip: request.ip,
      });
      return { id: userId, ...after };
    });
  });
}
