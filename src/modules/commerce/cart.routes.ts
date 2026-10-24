import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withRuntimeTransaction,type Database } from '../../database/pool.js';
import { AppError,notFound } from '../../shared/errors.js';
import { parseIdempotencyKey,requestHash } from '../../shared/idempotency.js';
import { slugSchema } from './inventory.schemas.js';
export function cartTokenHash(token:unknown){
  const parsed=z.string().regex(/^[A-Za-z0-9_-]{43}$/).safeParse(token);
  if(!parsed.success)throw new AppError(401,'CART_POSSESSION_REQUIRED','Não foi possível identificar este carrinho neste dispositivo.');
  return createHash('sha256').update(parsed.data).digest('hex');
}
export function cartError(error:unknown):never{
  const code=(error as {code?:string}).code;
  if(code==='P0002')throw notFound('Carrinho ou catálogo indisponível.');
  if(code==='40001')throw new AppError(409,'CART_VERSION_CONFLICT','O carrinho foi alterado em outra aba. Confira os itens e tente novamente.');
  if(code==='23505')throw new AppError(409,'CART_IDEMPOTENCY_CONFLICT','Esta operação já foi utilizada com outros dados. Atualize o carrinho.');
  if(code==='23514')throw new AppError(409,'CART_INSUFFICIENT_STOCK','A quantidade solicitada não está disponível. Atualize o carrinho.');
  if(code==='P0001')throw new AppError(409,'CART_ITEM_UNAVAILABLE','Este item não está disponível no catálogo. Os demais itens foram mantidos.');
  if(code==='55000')throw new AppError(409,'CART_EXPIRED','Seu carrinho precisa ser revisado. Atualize os itens antes de continuar.');
  if(code==='54000')throw new AppError(422,'CART_ITEM_LIMIT','O carrinho comporta até 50 variações diferentes.');
  if(code==='22023')throw new AppError(422,'CART_INVALID','Confira a quantidade e tente novamente.');
  throw error;
}
export async function cartRoutes(app:FastifyInstance,db:Database){
  const config={rateLimit:{max:60,timeWindow:'1 minute'}};
  const params=z.object({id:z.uuid()});
  app.post('/public/commerce/stores/:slug/carts',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
    const {slug}=z.object({slug:slugSchema}).parse(req.params),hash=cartTokenHash(req.headers['x-commerce-cart-token']);
    z.object({}).strict().parse(req.body);parseIdempotencyKey(req.headers['idempotency-key']);reply.header('Cache-Control','no-store');
    try{return await withRuntimeTransaction(db,async c=>{
      const id=(await c.query<{id:string}>('SELECT commerce_cart_open($1,$2) AS id',[slug,hash])).rows[0]!.id;
      return (await c.query('SELECT commerce_cart_read($1,$2) AS data',[id,hash])).rows[0]!.data;
    });}catch(error){return cartError(error);}
  });
  app.get('/public/commerce/carts/:id',{config},async(req,reply)=>{
    const {id}=params.parse(req.params),hash=cartTokenHash(req.headers['x-commerce-cart-token']);reply.header('Cache-Control','no-store');
    const data=await withRuntimeTransaction(db,async c=>(await c.query('SELECT commerce_cart_read($1,$2) AS data',[id,hash])).rows[0]?.data);
    if(!data)throw notFound('Carrinho indisponível.');return data;
  });
  for(const refresh of [false,true])app.route({method:refresh?'POST':'PUT',url:`/public/commerce/carts/:id/${refresh?'refresh':'items/:variantId'}`,config,handler:async(req,reply)=>{
    const {id,variantId}=params.extend({variantId:z.uuid().optional()}).parse(req.params);
    const hash=cartTokenHash(req.headers['x-commerce-cart-token']),key=parseIdempotencyKey(req.headers['idempotency-key']);
    const input=(refresh?z.object({expectedVersion:z.number().int().positive()}).strict():z.object({expectedVersion:z.number().int().positive(),quantity:z.number().int().min(0).max(99),preparationNotes:z.string().trim().max(500).optional()}).strict()).parse(req.body);
    const quantity='quantity' in input?input.quantity:null;reply.header('Cache-Control','no-store');
    try{return await withRuntimeTransaction(db,async c=>(await c.query('SELECT commerce_cart_change_with_notes($1,$2,$3,$4,$5,$6,$7,$8,$9) AS data',[id,hash,variantId??null,quantity,input.expectedVersion,key,requestHash({refresh,variantId:variantId??null,...input}),refresh,'preparationNotes' in input?input.preparationNotes??null:null])).rows[0]!.data);
    }catch(error){return cartError(error);}
  }});
}
