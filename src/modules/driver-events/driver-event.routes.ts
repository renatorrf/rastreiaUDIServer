import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import { parseIdempotencyKey } from '../../shared/idempotency.js';
import { createEventSchema, eventPolicies, type DriverEventPublisher } from './driver-event.types.js';
import { closeDriverEvent, createDriverEvent, listDriverEvents } from './driver-event.service.js';

export async function driverEventRoutes(app:FastifyInstance,database:Database,env:AppEnv,publisher:DriverEventPublisher) {
  const auth=authenticate(env,database);
  // A committed occurrence must not appear to have failed if realtime is temporarily unavailable.
  const safePublisher:DriverEventPublisher={publishEvent:async update=>{
    try{await publisher.publishEvent(update);}catch{app.log.error({eventId:update.event.id},'Ocorrência salva; publicação realtime indisponível.');}
  }};
  app.get('/driver-events/types',{preHandler:auth},async(_request,reply)=>{
    reply.header('Cache-Control','no-store');return {data:Object.entries(eventPolicies).map(([eventType,policy])=>({eventType,...policy}))};
  });
  app.get('/driver-events',{preHandler:auth},async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    const query=z.object({status:z.enum(['OPEN','RESOLVED','CANCELLED']).optional(),deliveryId:z.uuid().optional(),batchId:z.uuid().optional(),storeId:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(500).default(200)}).parse(request.query);
    return listDriverEvents(database,request.auth,query);
  });
  app.post('/driver-events',{preHandler:[auth,requireRoles('COURIER')],config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(request,reply)=>{
    const result=await createDriverEvent(database,request.auth,parseIdempotencyKey(request.headers['idempotency-key']),createEventSchema.parse(request.body),safePublisher,request.ip);
    return reply.header('Cache-Control','no-store').header('Idempotency-Replayed',String(result.replayed)).status(result.statusCode).send(result.body);
  });
  for(const action of ['resolve','cancel'] as const)app.patch(`/driver-events/:id/${action}`,{preHandler:auth},async(request,reply)=>{
    const {id}=z.object({id:z.uuid()}).parse(request.params);
    const result=await closeDriverEvent(database,request.auth,parseIdempotencyKey(request.headers['idempotency-key']),id,action==='resolve'?'RESOLVED':'CANCELLED',safePublisher,request.ip);
    return reply.header('Cache-Control','no-store').status(result.statusCode).send(result.body);
  });
}
