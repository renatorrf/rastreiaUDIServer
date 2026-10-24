import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withRuntimeTransaction,withTenantTransaction,type Database } from '../../database/pool.js';
import { assertIdentity,setIdentity } from '../auth/identity.service.js';
import { authenticate,requireRoles } from '../auth/auth.guard.js';
import { AppError,conflict,notFound } from '../../shared/errors.js';
import { parseIdempotencyKey,requestHash,withIdempotency } from '../../shared/idempotency.js';
import { cartTokenHash,cartError } from './cart.routes.js';
import { requireCommerceStore } from './commerce.service.js';

export const checkoutSchema=z.object({expectedVersion:z.number().int().positive(),fulfillment:z.enum(['DELIVERY','PICKUP']),
  profileId:z.uuid(),profileVersion:z.string().min(10).max(80).refine(value=>!Number.isNaN(Date.parse(value)), 'Confira a versão do cadastro.'),consent:z.literal(true)}).strict();
export const orderTransitionSchema=z.object({expectedVersion:z.number().int().positive(),status:z.enum(['CONFIRMED','CANCELLED','COMPLETED']),reason:z.string().trim().max(500).default('')}).strict()
  .refine(v=>v.status!=='CANCELLED'||v.reason.length>=5,{message:'Informe o motivo do cancelamento.',path:['reason']});
const pageSchema=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),offset:z.coerce.number().int().min(0).max(10000).default(0)});
function orderError(error:unknown):never {
  const code=(error as {code?:string}).code;
  if(code==='42501')throw new AppError(403,'CUSTOMER_OR_STORE_REQUIRED','Entre com sua conta de cliente ou confira sua permissão na loja.');
  if(code==='40001')throw new AppError(409,'ORDER_REVIEW_REQUIRED','Os dados foram alterados. Atualize os itens e confira os dados antes de confirmar.');
  if(['22023','22007','22008'].includes(code??''))throw new AppError(422,'ORDER_INVALID','Confira os itens, o endereço e a etapa do pedido.');
  return cartError(error);
}
export async function orderRoutes(app:FastifyInstance,db:Database,env:AppEnv){
  const identity=async<T>(req:FastifyRequest,run:(c:PoolClient)=>Promise<T>)=>{
    const auth=await assertIdentity(db,env,req.headers.authorization);
    return withRuntimeTransaction(db,async c=>{await setIdentity(c,auth.userId);
      const user=(await c.query<{must_change_password:boolean}>('SELECT must_change_password FROM users WHERE id=$1',[auth.userId])).rows[0];
      if(user?.must_change_password)throw conflict('Defina sua senha pessoal antes de continuar.');return run(c);});
  };
  app.get('/customer/commerce/checkout-profile',async(req,reply)=>{
    reply.header('Cache-Control','no-store');return identity(req,async c=>{
      const row=(await c.query(`SELECT id AS "profileId",updated_at::text AS "profileVersion",first_name||' '||last_name AS name,whatsapp_normalized AS whatsapp,
        address_line AS "addressLine",address_number AS "addressNumber",complement,neighborhood,city,state,postal_code AS "postalCode"
        FROM customer_profiles WHERE user_id=current_user_id() AND status='ACTIVE' ORDER BY updated_at DESC,id LIMIT 1`)).rows[0];
      if(!row)throw notFound('Ative seu cadastro de cliente antes de enviar pedidos.');return row;
    });
  });
  app.post('/customer/commerce/carts/:id/checkout',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
    const {id}=z.object({id:z.uuid()}).parse(req.params),input=checkoutSchema.parse(req.body);
    parseIdempotencyKey(req.headers['idempotency-key']);const owner=cartTokenHash(req.headers['x-commerce-cart-token']);
    reply.header('Cache-Control','no-store');
    try{return await identity(req,async c=>(await c.query('SELECT commerce_checkout($1,$2,$3,$4,$5,$6,$7) AS data',
      [id,owner,input.expectedVersion,requestHash(input),input.fulfillment,input.profileId,input.profileVersion])).rows[0]!.data);}catch(e){return orderError(e);}
  });
  app.get('/customer/commerce/orders',async(req,reply)=>{
    const f=pageSchema.parse(req.query);reply.header('Cache-Control','no-store');return identity(req,async c=>({data:(await c.query(
      'SELECT commerce_order_read(id) AS data FROM commerce_orders WHERE customer_user_id=current_user_id() ORDER BY created_at DESC,id LIMIT $1 OFFSET $2',[f.limit,f.offset])).rows.map((r:{data:unknown})=>r.data)}));
  });
  app.get('/customer/commerce/orders/:id',async(req,reply)=>{
    const {id}=z.object({id:z.uuid()}).parse(req.params);reply.header('Cache-Control','no-store');return identity(req,async c=>{
      const data=(await c.query('SELECT commerce_order_read(id) AS data FROM commerce_orders WHERE id=$1 AND customer_user_id=current_user_id()',[id])).rows[0]?.data;
      if(!data)throw notFound('Pedido não encontrado.');return data;
    });
  });
  const manager=[authenticate(env,db),requireRoles('TENANT_MANAGER')];
  app.get('/commerce/stores/:storeId/orders',{preHandler:manager},async(req,reply)=>{
    const {storeId}=z.object({storeId:z.uuid()}).parse(req.params);const f=pageSchema.extend({status:z.enum(['ACTIVE','ALL']).default('ACTIVE')}).parse(req.query);
    reply.header('Cache-Control','no-store');return withTenantTransaction(db,req.auth,async c=>{await requireCommerceStore(c,storeId);
      return {data:(await c.query(`SELECT commerce_order_read(id) AS data FROM commerce_orders WHERE store_id=$1 AND ($2='ALL' OR status IN ('RECEIVED','CONFIRMED')) ORDER BY created_at DESC,id LIMIT $3 OFFSET $4`,[storeId,f.status,f.limit,f.offset])).rows.map((r:{data:unknown})=>r.data)};
    });
  });
  app.patch('/commerce/stores/:storeId/orders/:id',{preHandler:manager},async(req,reply)=>{
    const ids=z.object({storeId:z.uuid(),id:z.uuid()}).parse(req.params),input=orderTransitionSchema.parse(req.body),key=parseIdempotencyKey(req.headers['idempotency-key']);
    try{const result=await withTenantTransaction(db,req.auth,c=>withIdempotency(c,req.auth,key,'commerce.order.transition',{...ids,...input},async()=>({statusCode:200,body:(await c.query(
      'SELECT commerce_order_transition($1,$2,$3,$4,$5) AS data',[ids.id,ids.storeId,input.expectedVersion,input.status,input.reason])).rows[0]!.data})));
      return reply.header('Cache-Control','no-store').header('Idempotency-Replayed',String(result.replayed)).code(result.statusCode).send(result.body);
    }catch(e){return orderError(e);}
  });
}
