import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { parseIdempotencyKey, type IdempotentResult } from '../../shared/idempotency.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import {
  acceptShiftPosition, approveShiftApplication, checkinShiftPosition, checkoutShiftPosition,
  createShiftSlot, listShiftPositions,
} from './shift.service.js';
import { createShiftTemplate, generateShiftTemplate, listShiftTemplates } from './shift-template.service.js';
import { getCourierAvailability, setCourierAvailability } from './courier-availability.service.js';
import { startEmergencySearch } from './shift-search.service.js';
import {
  cancelShiftPosition, requestShiftWithdrawal, resolveShiftChangeRequest,
  respondShiftConfirmation, transferShiftPosition,
} from './shift-change.service.js';

const idSchema = z.object({ id: z.uuid() });
const listSchema = z.object({
  from: z.coerce.date().default(() => new Date(Date.now() - 24 * 60 * 60 * 1000)),
  to: z.coerce.date().default(() => new Date(Date.now() + 31 * 24 * 60 * 60 * 1000)),
  storeId: z.uuid().optional(),
}).refine((input) => input.to > input.from, { path: ['to'], message: 'O período final deve ser posterior ao inicial.' });

const createSchema = z.object({
  storeId: z.uuid(),
  label: z.string().trim().min(2).max(120),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  headcount: z.number().int().min(1).max(50).default(1),
  holderCourierIds: z.array(z.uuid()).max(50).default([]),
  checkinOpenMinutes: z.number().int().min(0).max(240).default(30),
  checkinToleranceMinutes: z.number().int().min(0).max(240).default(10),
  checkinRadiusM: z.number().int().min(0).max(5000).default(250),
  searchRadiusM: z.number().int().min(100).max(100000).default(5000),
  compensationCents: z.number().int().min(0).default(0),
  requirements: z.record(z.string(), z.unknown()).default({}),
  autoApproveSubstitutes: z.boolean().default(true),
  confirmationLeadMinutes: z.number().int().min(15).max(10080).default(1440),
  withdrawalNoticeMinutes: z.number().int().min(0).max(10080).default(720),
}).refine((input) => input.endsAt > input.startsAt, {
  path: ['endsAt'], message: 'O fim do turno deve ser posterior ao início.',
}).refine((input) => input.endsAt.getTime() > input.startsAt.getTime() + input.checkinToleranceMinutes * 60_000, {
  path: ['checkinToleranceMinutes'], message: 'A tolerância de check-in deve terminar antes do fim do turno.',
});

const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().positive().max(1000),
});

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const templateSchema = z.object({
  storeId: z.uuid(), name: z.string().trim().min(2).max(120),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  localStartTime: z.string().regex(timePattern), localEndTime: z.string().regex(timePattern),
  headcount: z.number().int().min(1).max(50).default(1),
  holderCourierIds: z.array(z.uuid()).max(50).default([]),
  checkinOpenMinutes: z.number().int().min(0).max(240).default(30),
  checkinToleranceMinutes: z.number().int().min(0).max(240).default(10),
  checkinRadiusM: z.number().int().min(0).max(5000).default(250),
  searchRadiusM: z.number().int().min(500).max(100000).default(10000),
  compensationCents: z.number().int().min(0).default(0),
  requirements: z.record(z.string(), z.unknown()).default({}),
  autoApproveSubstitutes: z.boolean().default(true),
  confirmationLeadMinutes: z.number().int().min(15).max(10080).default(1440),
  withdrawalNoticeMinutes: z.number().int().min(0).max(10080).default(720),
});
const generationSchema = z.object({ through: z.coerce.date() });
const availabilitySchema = z.object({
  available: z.boolean(), latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(), accuracy: z.number().positive().max(1000).optional(),
  interestRadiusM: z.number().int().min(500).max(100000).default(5000),
  availableUntil: z.coerce.date().nullable().optional(),
});
const searchSchema = z.object({
  initialRadiusM: z.number().int().min(100).max(100000).default(2000),
  radiusStepM: z.number().int().min(100).max(100000).default(2000),
  waveDurationSeconds: z.number().int().min(30).max(3600).default(120),
});
const withdrawalSchema = z.object({
  reason: z.string().trim().min(3).max(500), suggestedCourierId: z.uuid().nullable().optional(),
});
const confirmationSchema = z.object({
  response: z.enum(['confirm', 'decline']), reason: z.string().trim().min(3).max(500).optional(),
});
const resolveChangeSchema = z.object({
  approve: z.boolean(), replacementCourierId: z.uuid().nullable().optional(),
  resolutionNote: z.string().trim().min(3).max(500).nullable().optional(),
});
const transferSchema = z.object({ courierId: z.uuid(), reason: z.string().trim().min(3).max(500) });
const cancellationSchema = z.object({ reason: z.string().trim().min(3).max(500) });

function keyFrom(request: FastifyRequest): string {
  return parseIdempotencyKey(request.headers['idempotency-key']);
}

function sendIdempotent<T>(reply: FastifyReply, result: IdempotentResult<T>) {
  reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false');
  return reply.status(result.statusCode).send(result.body);
}

export async function shiftRoutes(app: FastifyInstance, database: Database, env: AppEnv): Promise<void> {
  const auth = authenticate(env, database);

  app.get('/shift-positions', { preHandler: auth }, async (request) =>
    listShiftPositions(database, request.auth, listSchema.parse(request.query)));

  app.get('/shift-templates', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request) => listShiftTemplates(database, request.auth));

  app.post('/shift-templates', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request, reply) => sendIdempotent(reply, await createShiftTemplate(
    database, request.auth, keyFrom(request), templateSchema.parse(request.body), request.ip,
  )));

  app.post('/shift-templates/:id/generate', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request) => {
    const { id } = idSchema.parse(request.params);
    const { through } = generationSchema.parse(request.body);
    return generateShiftTemplate(database, request.auth, id, through);
  });

  app.get('/courier/availability', {
    preHandler: [auth, requireRoles('COURIER')],
  }, async (request) => getCourierAvailability(database, request.auth));

  app.put('/courier/availability', {
    preHandler: [auth, requireRoles('COURIER')],
  }, async (request) => setCourierAvailability(database, request.auth, availabilitySchema.parse(request.body)));

  app.post('/shift-slots', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request, reply) => {
    const result = await createShiftSlot(database, request.auth, keyFrom(request), createSchema.parse(request.body), request.ip);
    return sendIdempotent(reply, result);
  });

  app.post('/shift-positions/:id/accept', {
    preHandler: [auth, requireRoles('COURIER')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return sendIdempotent(reply, await acceptShiftPosition(database, request.auth, keyFrom(request), id, request.ip));
  });

  app.post('/shift-applications/:id/approve', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return sendIdempotent(reply, await approveShiftApplication(database, request.auth, keyFrom(request), id, request.ip));
  });

  app.post('/shift-positions/:id/check-in', {
    preHandler: [auth, requireRoles('COURIER')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const input = locationSchema.parse(request.body);
    return sendIdempotent(reply, await checkinShiftPosition(database, request.auth, keyFrom(request), id, input, request.ip));
  });

  app.post('/shift-positions/:id/check-out', {
    preHandler: [auth, requireRoles('COURIER')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return sendIdempotent(reply, await checkoutShiftPosition(database, request.auth, keyFrom(request), id, request.ip));
  });

  app.post('/shift-positions/:id/withdrawal', {
    preHandler: [auth, requireRoles('COURIER')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return sendIdempotent(reply, await requestShiftWithdrawal(
      database, request.auth, keyFrom(request), id, withdrawalSchema.parse(request.body), request.ip,
    ));
  });

  app.post('/shift-positions/:id/confirmation', {
    preHandler: [auth, requireRoles('COURIER')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const input = confirmationSchema.parse(request.body);
    return sendIdempotent(reply, await respondShiftConfirmation(
      database, request.auth, keyFrom(request), id, input.response, input.reason, request.ip,
    ));
  });

  app.post('/shift-change-requests/:id/resolve', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return sendIdempotent(reply, await resolveShiftChangeRequest(
      database, request.auth, keyFrom(request), id, resolveChangeSchema.parse(request.body), request.ip,
    ));
  });

  app.post('/shift-positions/:id/transfer', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return sendIdempotent(reply, await transferShiftPosition(
      database, request.auth, keyFrom(request), id, transferSchema.parse(request.body), request.ip,
    ));
  });

  app.post('/shift-positions/:id/cancel', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const { reason } = cancellationSchema.parse(request.body);
    return sendIdempotent(reply, await cancelShiftPosition(
      database, request.auth, keyFrom(request), id, reason, request.ip,
    ));
  });

  app.post('/shift-positions/:id/search', {
    preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')],
  }, async (request) => {
    const { id } = idSchema.parse(request.params);
    return startEmergencySearch(database, request.auth, id, searchSchema.parse(request.body));
  });
}
