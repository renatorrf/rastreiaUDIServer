import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withTenantTransaction,type Database } from '../../database/pool.js';
import { authenticate,requireRoles } from '../auth/auth.guard.js';
import { confirmManagerPassword } from '../auth/confirm-manager-password.js';
import { parseIdempotencyKey,withIdempotency } from '../../shared/idempotency.js';
import { AppError } from '../../shared/errors.js';
import { requireCommerceStore } from './commerce.service.js';
import { parseCatalogFile,errorCsv } from './catalog-file.js';
import { applyImport,importOptionsSchema,importView,loadImport,previewImport,type ImportJob } from './catalog-import.service.js';
export async function catalogImportRoutes(app:FastifyInstance,db:Database,env:AppEnv){
  const manager=[authenticate(env,db),requireRoles('TENANT_MANAGER')];
  const params=z.object({storeId:z.uuid()}),jobParams=params.extend({id:z.uuid()});
  const path='/commerce/stores/:storeId/imports';
  app.get(path,{preHandler:manager},req=>withTenantTransaction(db,req.auth,async c=>{
    const {storeId}=params.parse(req.params);await requireCommerceStore(c,storeId);
    return {data:(await c.query(`SELECT j.id,j.file_name AS "fileName",j.state,j.result,j.created_at AS "createdAt",u.name AS "createdBy" FROM commerce_import_jobs j LEFT JOIN users u ON u.id=j.created_by WHERE j.store_id=$1 ORDER BY j.created_at DESC,j.id LIMIT 20`,[storeId])).rows};
  }));
  app.post(path,{preHandler:manager,config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{
    const {storeId}=params.parse(req.params);
    await withTenantTransaction(db,req.auth,c=>requireCommerceStore(c,storeId));
    const file=await req.file({limits:{files:1,fileSize:5*1024*1024,fields:0,parts:1}});
    if(!file)throw new AppError(422,'FILE_REQUIRED','Selecione um arquivo.');
    const buffer=await file.toBuffer(),source=await parseCatalogFile(buffer,file.filename);
    const hash=createHash('sha256').update(buffer).digest('hex'),filename=Array.from(file.filename.split(/[\\/]/).pop()!).filter(char=>char.charCodeAt(0)>=32).join('').slice(0,160);
    return withTenantTransaction(db,req.auth,async c=>{
      await requireCommerceStore(c,storeId);
      await c.query('INSERT INTO commerce_import_jobs(tenant_id,store_id,file_name,file_hash,source,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(store_id,file_hash) DO NOTHING',[req.auth.tenantId,storeId,filename,hash,JSON.stringify(source),req.auth.userId]);
      return importView((await c.query<ImportJob>('SELECT * FROM commerce_import_jobs WHERE store_id=$1 AND file_hash=$2',[storeId,hash])).rows[0]!);
    });
  });
  app.get(path+'/:id',{preHandler:manager},req=>withTenantTransaction(db,req.auth,async c=>{const {storeId,id}=jobParams.parse(req.params);return importView(await loadImport(c,storeId,id));}));
  app.post(path+'/:id/preview',{preHandler:manager},req=>withTenantTransaction(db,req.auth,c=>{const {storeId,id}=jobParams.parse(req.params);return previewImport(c,storeId,id,importOptionsSchema.parse(req.body));}));
  app.post(path+'/:id/apply',{preHandler:[...manager,confirmManagerPassword(db)],config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(req,reply)=>{
    const {storeId,id}=jobParams.parse(req.params),{confirmationPassword:secret,...input}=z.object({previewToken:z.uuid(),reason:z.string().trim().min(5).max(300),confirmationPassword:z.string().min(1).max(200)}).strict().parse(req.body);void secret;
    const key=parseIdempotencyKey(req.headers['idempotency-key']);
    const result=await withTenantTransaction(db,req.auth,async c=>{await requireCommerceStore(c,storeId);return withIdempotency(c,req.auth,key,'commerce.catalog.import',{storeId,id,...input},async()=>({statusCode:200,body:await applyImport(c,req.auth,storeId,id,input.previewToken,input.reason)}));});
    return reply.header('Idempotency-Replayed',String(result.replayed)).send(result.body);
  });
  app.get(path+'/:id/errors',{preHandler:manager},async(req,reply)=>{
    const {storeId,id}=jobParams.parse(req.params),job=await withTenantTransaction(db,req.auth,c=>loadImport(c,storeId,id));
    return reply.type('text/csv; charset=utf-8').header('Cache-Control','no-store').header('Content-Disposition','attachment; filename="erros-catalogo.csv"').send(errorCsv(job.preview??[]));
  });
}
