import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction } from '../../database/pool.js';
import { workdaySelect } from './working-hours.js';
import { parseIdempotencyKey } from '../../shared/idempotency.js';
import { unauthorized } from '../../shared/errors.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import type { LocationPublisher } from '../locations/location.types.js';
import { getMyWorkdays, respondWorkday } from './workday.service.js';
import { createWorkdayTrackingSession, ingestNativeWorkdayPoint, ingestWorkdayPoints, revokeWorkdayTrackingSession } from './workday-tracking.service.js';

const params = z.object({id:z.uuid()});
const coordinates = {latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180),accuracy:z.number().positive().max(1000)};
const point = z.object({...coordinates,eventId:z.uuid(),capturedAt:z.coerce.date(),speed:z.number().min(0).max(100).nullable().optional(),heading:z.number().min(0).max(360).nullable().optional()});

export async function workdayRoutes(app: FastifyInstance, database: Database, env: AppEnv, publisher: LocationPublisher) {
  const preHandler = [authenticate(env,database),requireRoles('COURIER')];
  app.get('/workdays',{preHandler:[authenticate(env,database),requireRoles('TENANT_MANAGER','STORE_OPERATOR')]},request =>
    withTenantTransaction(database,request.auth,async client=>({data:(await client.query(`${workdaySelect}
      WHERE day.tenant_id=$1 AND day.ends_at>now()-interval '12 hours' AND day.starts_at<now()+interval '24 hours'
      ORDER BY day.starts_at,store.name,person.name LIMIT 500`,[request.auth.tenantId])).rows})));
  app.get('/courier/workdays',{preHandler},request => getMyWorkdays(database,request.auth));
  for (const action of ['confirm','decline','check-in','check-out'] as const) {
    app.post(`/courier/workdays/:id/${action}`,{preHandler},async (request,reply) => {
      const {id} = params.parse(request.params);
      const input = z.object({consent:z.boolean().default(false)}).parse(request.body ?? {});
      const eventId=parseIdempotencyKey(request.headers['idempotency-key']);
      const result = await respondWorkday(database,request.auth,id,eventId,action,input.consent,request.ip);
      request.log.info({event_id:eventId,user_id:request.auth.userId,tenant_id:request.auth.tenantId,
        store_id:result.body.storeId,courier_id:result.body.courierId,shift_assignment_id:id,
        new_status:result.body.status,replayed:result.replayed},'Courier workday transition completed');
      return reply.header('Idempotency-Replayed',String(result.replayed)).status(result.statusCode).send(result.body);
    });
  }
  app.post('/courier/workdays/:id/locations',{preHandler},request => {
    const {id} = params.parse(request.params);
    return ingestWorkdayPoints(database,publisher,request.auth,id,z.object({points:z.array(point).min(1).max(100)}).parse(request.body).points);
  });
  app.post('/courier/workdays/:id/tracking-session',{preHandler},request => {
    const {id} = params.parse(request.params);
    return createWorkdayTrackingSession(database,env,request.auth,id,z.object({platform:z.enum(['android','ios'])}).parse(request.body).platform);
  });
  app.delete('/courier/workday-tracking-sessions/:id',{preHandler},request => revokeWorkdayTrackingSession(database,request.auth,params.parse(request.params).id));
  app.post('/mobile/workday-location',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async (request,reply) => {
    const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw unauthorized('Sessão de rastreamento inválida.');
    const input = z.object({...coordinates,time:z.number().int().positive(),speed:z.number().min(-1).max(100).nullable().optional(),bearing:z.number().min(-1).max(360).nullable().optional(),altitude:z.number().nullable().optional()}).parse(request.body);
    return reply.status(202).send(await ingestNativeWorkdayPoint(database,publisher,env,token,input));
  });
}
