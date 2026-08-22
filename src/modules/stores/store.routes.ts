import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withTenantTransaction, type Database } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';

const storeSchema = z.object({
  name: z.string().trim().min(2).max(160),
  externalReference: z.string().trim().max(100).nullable().optional(),
  addressLine: z.string().trim().min(3).max(240),
  addressNumber: z.string().trim().max(30).nullable().optional(),
  complement: z.string().trim().max(120).nullable().optional(),
  neighborhood: z.string().trim().max(120).nullable().optional(),
  city: z.string().trim().min(2).max(120),
  state: z.string().trim().length(2).toUpperCase(),
  postalCode: z.string().trim().max(12).nullable().optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  addressConfidence: z.number().min(0).max(1).nullable().optional(),
  contactPhone: z.string().trim().max(30).nullable().optional(),
});

const storeSelect = `
  SELECT id, name, external_reference AS "externalReference", address_line AS "addressLine",
         address_number AS "addressNumber", complement, neighborhood, city, state,
         postal_code AS "postalCode", latitude, longitude, address_confidence AS "addressConfidence",
         contact_phone AS "contactPhone", status, created_at AS "createdAt", updated_at AS "updatedAt"
  FROM stores`;

export async function storeRoutes(app: FastifyInstance, database: Database, env: AppEnv): Promise<void> {
  const auth = authenticate(env, database);

  app.get('/stores', { preHandler: auth }, async (request) =>
    withTenantTransaction(database, request.auth, async (client) => {
      const result = request.auth.role === 'TENANT_MANAGER'
        ? await client.query(`${storeSelect} ORDER BY name`)
        : await client.query(`${storeSelect} WHERE id = ANY($1::uuid[]) ORDER BY name`, [request.auth.storeIds]);
      return { data: result.rows };
    }),
  );

  app.post('/stores', { preHandler: [auth, requireRoles('TENANT_MANAGER')] }, async (request, reply) => {
    const input = storeSchema.parse(request.body);
    const store = await withTenantTransaction(database, request.auth, async (client) => {
      const result = await client.query(
        `INSERT INTO stores
           (tenant_id, name, external_reference, address_line, address_number, complement,
            neighborhood, city, state, postal_code, longitude, latitude, address_confidence,
            contact_phone, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13, $14, $15, $15)
         RETURNING id, name, city, state, status, latitude, longitude, created_at AS "createdAt"`,
        [request.auth.tenantId, input.name, input.externalReference ?? null, input.addressLine,
          input.addressNumber ?? null, input.complement ?? null, input.neighborhood ?? null,
          input.city, input.state, input.postalCode ?? null, input.longitude, input.latitude,
          input.addressConfidence ?? null, input.contactPhone ?? null, request.auth.userId],
      );
      const created = result.rows[0];
      await writeAudit(client, {
        tenantId: request.auth.tenantId,
        actorUserId: request.auth.userId,
        action: 'store.created',
        entityType: 'store',
        entityId: created.id as string,
        afterData: created,
        ip: request.ip,
      });
      return created;
    });
    return reply.status(201).send(store);
  });
}
