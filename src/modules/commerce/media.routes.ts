import { createHash,randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import { withRuntimeTransaction,withTenantTransaction,type Database } from '../../database/pool.js';
import type { ObjectStorage } from '../../integrations/objects/object-storage.js';
import { authenticate,requireRoles } from '../auth/auth.guard.js';
import { parseIdempotencyKey,withIdempotency } from '../../shared/idempotency.js';
import { writeAudit } from '../../shared/audit.js';
import { AppError,conflict,notFound } from '../../shared/errors.js';
import { requireCommerceStore } from './commerce.service.js';
import { assertVersion } from './inventory.service.js';
export const MAX_UPLOAD=5*1024*1024;
let activeDecoders=0;
export async function optimizeProductImage(input:Buffer){
  if(input.length>MAX_UPLOAD)throw new AppError(413,'IMAGE_TOO_LARGE','Envie uma foto de até 5 MB.');
  const signature=input.subarray(0,12);
  const raster=signature.subarray(0,3).equals(Buffer.from([255,216,255]))||signature.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||(signature.toString('ascii',0,4)==='RIFF'&&signature.toString('ascii',8,12)==='WEBP');
  if(!raster)throw new AppError(422,'IMAGE_INVALID','Use uma foto JPEG, PNG ou WebP válida.');
  if(activeDecoders>=2)throw new AppError(429,'IMAGE_PROCESSING_BUSY','Há outras fotos em processamento. Aguarde alguns segundos e tente novamente.');
  activeDecoders++;
  try {
    const image=sharp(input,{limitInputPixels:16_000_000,failOn:'warning'}).timeout({seconds:15});
    const meta=await image.metadata();
    if(!['jpeg','png','webp'].includes(meta.format)||Number(meta.pages??1)!==1)throw new Error('format');
    const {data,info}=await image.rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer({resolveWithObject:true});
    const thumbnail=await sharp(data).resize(400,400,{fit:'inside',withoutEnlargement:true}).webp({quality:75}).toBuffer();
    return {data,thumbnail,width:info.width,height:info.height,checksum:createHash('sha256').update(input).digest('hex')};
  }catch{throw new AppError(422,'IMAGE_INVALID','Use uma foto JPEG, PNG ou WebP estática, válida e de até 16 megapixels.');}
  finally{activeDecoders--;}
}
const ids=z.object({storeId:z.uuid(),productId:z.uuid()});
const imageIds=ids.extend({id:z.uuid()});
const select=`SELECT id,alt,width,height,position FROM commerce_product_images WHERE store_id=$1 AND product_id=$2 AND NOT archived ORDER BY position,id`;
async function parent(c:PoolClient,store:string,product:string,lock=false){
  await requireCommerceStore(c,store);
  const row=(await c.query<{version:number;name:string}>(`SELECT media_version AS version,name FROM commerce_products WHERE id=$1 AND store_id=$2${lock?' FOR UPDATE':''}`,[product,store])).rows[0];
  if(!row)throw notFound();return row;
}
export async function mediaRoutes(app:FastifyInstance,db:Database,env:AppEnv,storage:ObjectStorage){
  const manager=[authenticate(env,db),requireRoles('TENANT_MANAGER')];
  const path='/commerce/stores/:storeId/products/:productId/images';
  app.get(path,{preHandler:manager},req=>withTenantTransaction(db,req.auth,async c=>{
    const {storeId,productId}=ids.parse(req.params),p=await parent(c,storeId,productId);
    return {...p,data:(await c.query(select,[storeId,productId])).rows};
  }));
  app.post(path,{preHandler:manager,config:{rateLimit:{max:12,timeWindow:'1 minute'}}},async(req,reply)=>{
    const {storeId,productId}=ids.parse(req.params),input=z.object({expectedVersion:z.coerce.number().int().positive(),alt:z.string().trim().max(160).default('')}).parse(req.query);
    const key=parseIdempotencyKey(req.headers['idempotency-key']);
    await withTenantTransaction(db,req.auth,c=>parent(c,storeId,productId));
    const file=await req.file({limits:{files:1,fileSize:MAX_UPLOAD,fields:0,parts:1}});
    if(!file)throw new AppError(422,'FILE_REQUIRED','Selecione uma foto.');
    const optimized=await optimizeProductImage(await file.toBuffer());
    const imageId=randomUUID(),base=`${req.auth.tenantId}/catalog/${storeId}/${productId}/${imageId}`;
    const objectKey=`${base}.webp`,thumbnailKey=`${base}-thumb.webp`;
    let wrote=false;
    try {
      const result=await withTenantTransaction(db,req.auth,c=>withIdempotency(c,req.auth,key,'commerce.image.upload',{storeId,productId,...input,checksum:optimized.checksum},async()=>{
        const p=await parent(c,storeId,productId,true);assertVersion(p.version,input.expectedVersion);
        const images=(await c.query<{id:string}>(select,[storeId,productId])).rows;
        if(images.length>=6)throw conflict('O produto já possui 6 fotos. Remova uma antes de enviar outra.');
        wrote=true;await storage.put(objectKey,optimized.data);await storage.put(thumbnailKey,optimized.thumbnail);
        await c.query(`INSERT INTO commerce_product_images(id,tenant_id,store_id,product_id,object_key,thumbnail_key,checksum,alt,width,height,bytes,position,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[imageId,req.auth.tenantId,storeId,productId,objectKey,thumbnailKey,optimized.checksum,input.alt||p.name,optimized.width,optimized.height,optimized.data.length,images.length,req.auth.userId]);
        await c.query('UPDATE commerce_products SET media_version=media_version+1 WHERE id=$1',[productId]);
        await writeAudit(c,{tenantId:req.auth.tenantId,actorUserId:req.auth.userId,action:'commerce.image.uploaded',entityType:'commerce_product',entityId:productId,afterData:{imageId,bytes:optimized.data.length}});
        return {statusCode:200,body:{id:imageId,version:p.version+1}};
      }));
      return reply.header('Idempotency-Replayed',String(result.replayed)).send(result.body);
    }catch(error){
      // A lost COMMIT response is ambiguous. Never delete an object until a fresh DB read proves it was not committed.
      if(wrote)try{const exists=await withTenantTransaction(db,req.auth,async c=>{await requireCommerceStore(c,storeId);return (await c.query('SELECT id FROM commerce_product_images WHERE id=$1',[imageId])).rowCount;});
        if(!exists)await Promise.all([storage.remove(objectKey),storage.remove(thumbnailKey)]);
      }catch{app.log.warn({imageId},'Catalog image cleanup deferred; database/storage unavailable');}
      throw error;
    }
  });
  app.patch(path,{preHandler:manager},async(req,reply)=>{
    const {storeId,productId}=ids.parse(req.params),input=z.object({expectedVersion:z.number().int().positive(),images:z.array(z.object({id:z.uuid(),alt:z.string().trim().min(1).max(160)}).strict()).max(6)}).strict().parse(req.body);
    if(new Set(input.images.map(i=>i.id)).size!==input.images.length)throw conflict('Fotos repetidas.');
    const result=await withTenantTransaction(db,req.auth,async c=>{await parent(c,storeId,productId);return withIdempotency(c,req.auth,parseIdempotencyKey(req.headers['idempotency-key']),'commerce.image.organize',{storeId,productId,...input},async()=>{
      const p=await parent(c,storeId,productId,true);assertVersion(p.version,input.expectedVersion);
      const current=(await c.query<{id:string}>(select,[storeId,productId])).rows;
      if(input.images.some(i=>!current.some(row=>row.id===i.id)))throw conflict('A galeria mudou. Atualize a página.');
      await c.query('UPDATE commerce_product_images SET archived=true WHERE product_id=$1 AND NOT (id=ANY($2::uuid[]))',[productId,input.images.map(i=>i.id)]);
      for(const [position,image] of input.images.entries())await c.query('UPDATE commerce_product_images SET position=$2,alt=$3 WHERE id=$1',[image.id,position,image.alt]);
      await c.query('UPDATE commerce_products SET media_version=media_version+1 WHERE id=$1',[productId]);
      await writeAudit(c,{tenantId:req.auth.tenantId,actorUserId:req.auth.userId,action:'commerce.image.organized',entityType:'commerce_product',entityId:productId,beforeData:current,afterData:input.images});
      return {statusCode:200,body:{version:p.version+1}};
    });});return reply.send(result.body);
  });
  app.get(path+'/:id/file',{preHandler:manager},async(req,reply)=>{
    const {storeId,productId,id}=imageIds.parse(req.params),thumb=z.object({thumbnail:z.enum(['true','false']).default('false')}).parse(req.query).thumbnail==='true';
    const key=await withTenantTransaction(db,req.auth,async c=>{await parent(c,storeId,productId);return (await c.query<{key:string}>(`SELECT ${thumb?'thumbnail_key':'object_key'} AS key FROM commerce_product_images WHERE id=$1 AND product_id=$2 AND store_id=$3 AND NOT archived`,[id,productId,storeId])).rows[0]?.key;});
    if(!key)throw notFound();return reply.type('image/webp').header('Cache-Control','no-store').send(await storage.open(key));
  });
  app.get('/public/commerce/stores/:slug/images/:id',{config:{rateLimit:{max:180,timeWindow:'1 minute'}}},async(req,reply)=>{
    const {slug,id}=z.object({slug:z.string().max(63),id:z.uuid()}).parse(req.params),thumb=z.object({thumbnail:z.enum(['true','false']).default('false')}).parse(req.query).thumbnail==='true';
    const key=await withRuntimeTransaction(db,async c=>(await c.query<{key:string|null}>('SELECT commerce_public_image($1,$2,$3) AS key',[slug,id,thumb])).rows[0]?.key);
    if(!key)throw notFound();return reply.type('image/webp').header('Cache-Control','no-store').header('Cross-Origin-Resource-Policy','cross-origin').send(await storage.open(key));
  });
}
