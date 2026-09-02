import type { FastifyInstance } from 'fastify';
import type { AppEnv } from '../../config/env.js';
import { withPlatformTransaction, type Database } from '../../database/pool.js';
import { authenticatePlatform } from '../auth/auth.guard.js';
import { assertIdentity, withIdentity } from '../auth/identity.service.js';
import { forbidden } from '../../shared/errors.js';
import { operationsReport, organizationTree, scopedUnits } from './operations.service.js';

export async function organizationOperationsRoutes(app:FastifyInstance,database:Database,env:AppEnv) {
  const master=authenticatePlatform(env,database);
  for(const section of ['summary','by-company','by-store','export'] as const) {
    for(const isMaster of [true,false]) {
      const path=`/${isMaster?'platform':'management'}/operations/${section}`;
      app.get(path,{...(isMaster?{preHandler:master}:{})},async(request,reply)=>{
        const identity=isMaster?undefined:await assertIdentity(database,env,request.headers.authorization);
        const report=isMaster?await withPlatformTransaction(database,request.platformAuth,client=>operationsReport(client,request.query)):
          await withIdentity(database,identity!.userId,client=>operationsReport(client,request.query,identity!.userId));
        reply.header('Cache-Control','no-store');
        if(section==='export') {
          const cell=(value:unknown)=>'"'+String(value).replace(/^[=+@-]/,"' $&").replaceAll('"','""')+'"';
          const csv=[['Grupo','Empresa','Unidade','Entregas','Em andamento','Concluídas','Falhas','Atrasadas'],
            ...report.stores.map(row=>[row.tenant_name,row.company_name,row.name,row.deliveries,row.active_deliveries,row.delivered,row.failed,row.late])]
            .map(row=>row.map(cell).join(';')).join('\r\n');
          return reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="operacao-consolidada.csv"').send('\uFEFF'+csv);
        }
        return section==='by-company'?{...report,data:report.companies}:section==='by-store'?{...report,data:report.stores}:report;
      });
    }
  }
  app.get('/me/organization-tree',async(request,reply)=>{
    const identity=await assertIdentity(database,env,request.headers.authorization);
    reply.header('Cache-Control','no-store');
    return withIdentity(database,identity.userId,async client=>{
      const units=(await scopedUnits(client,identity.userId)).filter(unit=>['TENANT_MANAGER','STORE_OPERATOR'].includes(unit.role??''));
      if(!units.length)throw forbidden('Nenhuma unidade de gestão autorizada.');return organizationTree(units);
    });
  });
  app.get('/me/effective-scopes',async(request,reply)=>{
    const identity=await assertIdentity(database,env,request.headers.authorization);
    reply.header('Cache-Control','no-store');
    return withIdentity(database,identity.userId,async client=>({
      units:await scopedUnits(client,identity.userId),
      grants:(await client.query(`SELECT id,tenant_id,company_id,store_id,scope_level,valid_from,valid_until FROM user_access_scopes
        WHERE user_id=$1 AND status='ACTIVE' AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now())`,[identity.userId])).rows,
    }));
  });
}
