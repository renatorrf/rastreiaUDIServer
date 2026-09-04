import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withTenantTransaction, type Database } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import type { AuthContext } from '../auth/auth.types.js';
import {
  localTimeSchema, operatingWeekdaysSchema, workingHoursFields, validWorkingHours,
} from '../workdays/working-hours.js';

export const storeSchema = z.object({
  ...workingHoursFields,
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
}).refine(validWorkingHours, { path: ['closingTime'], message: 'Informe início e fim diferentes, ou deixe ambos sem configuração.' });

export const storeWorkingHoursSchema = z.object({
  openingTime: localTimeSchema.nullable(),
  closingTime: localTimeSchema.nullable(),
  operatingWeekdays: operatingWeekdaysSchema,
  updatedAt: z.iso.datetime(),
}).refine(validWorkingHours, {
  path: ['closingTime'],
  message: 'Informe início e fim diferentes, ou deixe ambos sem configuração.',
});

export function canManageStoreWorkingHours(auth: AuthContext, storeId: string): boolean {
  return auth.role === 'TENANT_MANAGER'
    || (auth.role === 'STORE_OPERATOR' && auth.storeIds.includes(storeId));
}

const storeSelect = `
  SELECT id, name, external_reference AS "externalReference", address_line AS "addressLine",
         address_number AS "addressNumber", complement, neighborhood, city, state,
         postal_code AS "postalCode", latitude, longitude, address_confidence AS "addressConfidence",
         contact_phone AS "contactPhone", opening_time::text AS "openingTime", closing_time::text AS "closingTime",
         operating_weekdays AS "operatingWeekdays", status, created_at AS "createdAt", updated_at AS "updatedAt"
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

  app.post('/stores', { preHandler: auth }, async () => {
    throw forbidden('Somente o Master pode cadastrar unidades pelo painel administrativo.');
  });

  app.patch('/stores/:id/working-hours', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const input = storeWorkingHoursSchema.parse(request.body);
    if (!canManageStoreWorkingHours(request.auth, id)) {
      throw forbidden('Você só pode alterar os horários das unidades vinculadas ao seu acesso.');
    }

    return withTenantTransaction(database, request.auth, async (client) => {
      const current = await client.query(`${storeSelect} WHERE id = $1`, [id]);
      if (!current.rows[0]) throw notFound('Unidade não encontrada.');

      const updated = await client.query(
        `WITH changed AS (
           UPDATE stores
              SET opening_time = $2, closing_time = $3, operating_weekdays = $4, updated_at = now()
            WHERE id = $1 AND updated_at = $5::timestamptz
            RETURNING id
         )
         ${storeSelect}
         JOIN changed ON changed.id = stores.id`,
        [id, input.openingTime, input.closingTime, input.operatingWeekdays, input.updatedAt],
      );
      if (!updated.rows[0]) {
        throw conflict('Os horários foram alterados em outra sessão. Recarregue os dados antes de tentar novamente.');
      }

      await writeAudit(client, {
        tenantId: request.auth.tenantId,
        actorUserId: request.auth.userId,
        action: 'store.working_hours.updated',
        entityType: 'store',
        entityId: id,
        beforeData: {
          openingTime: current.rows[0].openingTime,
          closingTime: current.rows[0].closingTime,
          operatingWeekdays: current.rows[0].operatingWeekdays,
        },
        afterData: {
          openingTime: input.openingTime,
          closingTime: input.closingTime,
          operatingWeekdays: input.operatingWeekdays,
        },
        ip: request.ip,
      });
      return updated.rows[0];
    });
  });
}
