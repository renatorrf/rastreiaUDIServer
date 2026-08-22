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

const vehicleTypes = ['BICYCLE', 'MOTORCYCLE', 'CAR', 'VAN', 'ON_FOOT', 'OTHER'] as const;
const membershipStatuses = ['ACTIVE', 'BLOCKED', 'ARCHIVED'] as const;

const createCourierSchema = z.object({
  name: z.string().trim().min(2).max(160),
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(12).max(200),
  phone: z.string().trim().min(8).max(30),
  vehicleType: z.enum(vehicleTypes),
  storeIds: z.array(z.string().uuid()).min(1).max(100),
});

const linkCourierSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  storeIds: z.array(z.string().uuid()).min(1).max(100),
});

const updateCourierSchema = z.object({
  status: z.enum(membershipStatuses),
  storeIds: z.array(z.string().uuid()).max(100),
  reason: z.string().trim().min(4).max(500),
}).refine((input) => input.status !== 'ACTIVE' || input.storeIds.length > 0, {
  path: ['storeIds'], message: 'Um entregador ativo deve possuir ao menos uma loja vinculada.',
});

async function validateStores(client: PoolClient, storeIds: string[]): Promise<void> {
  if (!storeIds.length) return;
  const stores = await client.query<{ id: string }>('SELECT id FROM stores WHERE id = ANY($1::uuid[])', [storeIds]);
  if (stores.rowCount !== new Set(storeIds).size) throw conflict('Uma ou mais lojas não pertencem à empresa.');
}

async function activateLinks(
  client: PoolClient,
  tenantId: string,
  courierProfileId: string,
  storeIds: string[],
  actorUserId: string,
  status: 'ACTIVE' | 'BLOCKED' | 'ARCHIVED' = 'ACTIVE',
): Promise<void> {
  const linkStatus = status === 'ACTIVE' ? 'ACTIVE' : status === 'BLOCKED' ? 'BLOCKED' : 'ENDED';
  await client.query(
    `UPDATE courier_store_links SET status = 'ENDED', updated_by = $3
     WHERE tenant_id = $1 AND courier_profile_id = $2`,
    [tenantId, courierProfileId, actorUserId],
  );
  for (const storeId of [...new Set(storeIds)]) {
    await client.query(
      `INSERT INTO courier_store_links
         (tenant_id, store_id, courier_profile_id, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (tenant_id, store_id, courier_profile_id)
       DO UPDATE SET status = EXCLUDED.status, updated_by = EXCLUDED.updated_by`,
      [tenantId, storeId, courierProfileId, linkStatus, actorUserId],
    );
  }
}

export async function courierRoutes(app: FastifyInstance, database: Database, env: AppEnv): Promise<void> {
  const auth = authenticate(env, database);

  app.get('/couriers', { preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')] }, async (request) =>
    withTenantTransaction(database, request.auth, async (client) => {
      const allowedStores = request.auth.role === 'TENANT_MANAGER' ? null : request.auth.storeIds;
      const result = await client.query(
        `SELECT profile.id, profile.user_id AS "userId", u.name, u.email, profile.phone,
                profile.vehicle_type AS "vehicleType", profile.status, profile.status AS "profileStatus",
                membership.status AS "membershipStatus",
                COALESCE(array_agg(DISTINCT link.store_id) FILTER (WHERE link.status = 'ACTIVE'), '{}') AS "storeIds",
                COALESCE(json_agg(DISTINCT jsonb_build_object(
                  'id', link.id, 'storeId', link.store_id, 'storeName', store.name, 'status', link.status
                )), '[]') AS links,
                membership.created_at AS "createdAt", membership.updated_at AS "updatedAt"
         FROM courier_store_links link
         JOIN courier_profiles profile ON profile.id = link.courier_profile_id
         JOIN users u ON u.id = profile.user_id
         JOIN tenant_users membership ON membership.tenant_id = link.tenant_id
           AND membership.user_id = profile.user_id AND membership.role = 'COURIER'
         JOIN stores store ON store.id = link.store_id
         WHERE link.tenant_id = $1
           AND ($2::uuid[] IS NULL OR link.store_id = ANY($2::uuid[]))
         GROUP BY profile.id, u.id, membership.id
         ORDER BY CASE membership.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, u.name`,
        [request.auth.tenantId, allowedStores],
      );
      return { data: result.rows };
    }),
  );

  app.post('/couriers', { preHandler: [auth, requireRoles('TENANT_MANAGER')] }, async (request, reply) => {
    const input = createCourierSchema.parse(request.body);
    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1,
    });
    try {
      const created = await withTenantTransaction(database, request.auth, async (client) => {
        await validateStores(client, input.storeIds);
        const account = { id: randomUUID(), name: input.name, email: input.email };
        await client.query('INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)', [
          account.id, account.name, account.email, passwordHash,
        ]);
        await client.query(
          `INSERT INTO tenant_users (tenant_id, user_id, role, created_by, updated_by)
           VALUES ($1, $2, 'COURIER', $3, $3)`,
          [request.auth.tenantId, account.id, request.auth.userId],
        );
        const profile = await client.query<{ id: string; status: string }>(
          `INSERT INTO courier_profiles (user_id, phone, vehicle_type, status)
           VALUES ($1, $2, $3, 'ACTIVE') RETURNING id, status`,
          [account.id, input.phone, input.vehicleType],
        );
        await activateLinks(client, request.auth.tenantId, profile.rows[0]!.id, input.storeIds, request.auth.userId);
        const response = {
          id: profile.rows[0]!.id, userId: account.id, name: account.name, email: account.email,
          phone: input.phone, vehicleType: input.vehicleType, profileStatus: profile.rows[0]!.status,
          membershipStatus: 'ACTIVE', storeIds: input.storeIds,
        };
        await writeAudit(client, {
          tenantId: request.auth.tenantId, actorUserId: request.auth.userId, action: 'courier.created',
          entityType: 'courier_profile', entityId: profile.rows[0]!.id, afterData: response, ip: request.ip,
        });
        return response;
      });
      return reply.status(201).send(created);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw conflict('Já existe uma conta com este e-mail ou vínculo. Use “Vincular entregador existente”.');
      }
      throw error;
    }
  });

  app.post('/couriers/link', { preHandler: [auth, requireRoles('TENANT_MANAGER')] }, async (request, reply) => {
    const input = linkCourierSchema.parse(request.body);
    const linked = await withTenantTransaction(database, request.auth, async (client) => {
      await validateStores(client, input.storeIds);
      const accountResult = await client.query<{
        id: string; name: string; email: string; status: string; courier_profile_id: string | null;
        courier_profile_status: string | null;
      }>('SELECT * FROM rastreia.resolve_user_email($1)', [input.email]);
      const account = accountResult.rows[0];
      if (!account || account.status !== 'ACTIVE' || !account.courier_profile_id) {
        throw notFound('Entregador ativo não encontrado para este e-mail.');
      }
      if (account.courier_profile_status === 'BLOCKED') throw conflict('O perfil global deste entregador está bloqueado.');
      const existing = await client.query<{ role: string }>(
        'SELECT role FROM tenant_users WHERE tenant_id = $1 AND user_id = $2',
        [request.auth.tenantId, account.id],
      );
      if (existing.rowCount) throw conflict('Esta conta já está vinculada à empresa.');
      await client.query(
        `INSERT INTO tenant_users (tenant_id, user_id, role, created_by, updated_by)
         VALUES ($1, $2, 'COURIER', $3, $3)`,
        [request.auth.tenantId, account.id, request.auth.userId],
      );
      await activateLinks(
        client, request.auth.tenantId, account.courier_profile_id, input.storeIds, request.auth.userId,
      );
      const response = {
        id: account.courier_profile_id, userId: account.id, name: account.name, email: account.email,
        profileStatus: account.courier_profile_status, membershipStatus: 'ACTIVE', storeIds: input.storeIds,
      };
      await writeAudit(client, {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId, action: 'courier.linked',
        entityType: 'courier_profile', entityId: account.courier_profile_id, afterData: response, ip: request.ip,
      });
      return response;
    });
    return reply.status(201).send(linked);
  });

  app.patch('/couriers/:courierId', { preHandler: [auth, requireRoles('TENANT_MANAGER')] }, async (request) => {
    const { courierId } = z.object({ courierId: z.string().uuid() }).parse(request.params);
    const input = updateCourierSchema.parse(request.body);
    return withTenantTransaction(database, request.auth, async (client) => {
      await validateStores(client, input.storeIds);
      const targetResult = await client.query<{ user_id: string; membership_id: string; status: string; store_ids: string[] }>(
        `SELECT profile.user_id, membership.id AS membership_id, membership.status,
                COALESCE(array_agg(link.store_id) FILTER (WHERE link.status <> 'ENDED'), '{}') AS store_ids
         FROM courier_profiles profile
         JOIN tenant_users membership ON membership.user_id = profile.user_id
           AND membership.tenant_id = $1 AND membership.role = 'COURIER'
         LEFT JOIN courier_store_links link ON link.courier_profile_id = profile.id AND link.tenant_id = $1
         WHERE profile.id = $2
         GROUP BY profile.id, membership.id`,
        [request.auth.tenantId, courierId],
      );
      const target = targetResult.rows[0];
      if (!target) throw notFound('Entregador não encontrado nesta empresa.');
      const before = { status: target.status, storeIds: target.store_ids };
      await client.query(
        `UPDATE tenant_users SET status = $3, updated_by = $4
         WHERE tenant_id = $1 AND user_id = $2`,
        [request.auth.tenantId, target.user_id, input.status, request.auth.userId],
      );
      await activateLinks(
        client, request.auth.tenantId, courierId, input.storeIds, request.auth.userId, input.status,
      );
      await client.query(
        `UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, now())
         WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [request.auth.tenantId, target.user_id],
      );
      const after = { status: input.status, storeIds: input.storeIds, reason: input.reason };
      await writeAudit(client, {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId, action: 'courier.membership_updated',
        entityType: 'tenant_user', entityId: target.membership_id, beforeData: before, afterData: after, ip: request.ip,
      });
      return { id: courierId, ...after };
    });
  });
}
