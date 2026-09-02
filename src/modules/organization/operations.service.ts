import type { PoolClient } from 'pg';
import { z } from 'zod';
import { timezoneSchema } from '../billing/billing.schemas.js';
import { forbidden } from '../../shared/errors.js';
import { setTenantContext } from '../../database/pool.js';

export const operationsFilterSchema=z.object({tenantId:z.string().uuid().optional(),companyId:z.string().uuid().optional(),storeId:z.string().uuid().optional(),
  from:z.iso.date().default(()=>new Date(Date.now()-29*86400000).toISOString().slice(0,10)),to:z.iso.date().default(()=>new Date().toISOString().slice(0,10)),
  timezone:timezoneSchema.default('America/Sao_Paulo'),status:z.enum(['DRAFT','AWAITING_COURIER','ASSIGNED','AWAITING_PICKUP','COLLECTED','IN_ROUTE','NEXT_STOP','DELIVERED','CANCELLED','DELIVERY_FAILED','RETURN_STARTED','RETURNED']).optional(),
  courierId:z.string().uuid().optional(),
}).superRefine((v,c)=>{const days=(Date.parse(v.to)-Date.parse(v.from))/86400000;
  if(days<0||days>365)c.addIssue({code:'custom',path:['to'],message:'Selecione um período de até 366 dias, com início anterior ao fim.'});});
export interface OrganizationUnit {id:string;name:string;tenant_id:string;tenant_name:string;company_id:string;company_name:string;role?:string}
interface OperationRow extends OrganizationUnit {deliveries:number;active_deliveries:number;delivered:number;failed:number;late:number;open_incidents:number;active_routes:number;open_shifts:number;latitude:number;longitude:number}
interface OperationPosition {courier_id:string;store_id:string;delivery_id:string;latitude:number;longitude:number;captured_at:Date;stale:boolean}
export async function scopedUnits(client:PoolClient,userId?:string):Promise<OrganizationUnit[]> {
  return (await client.query<OrganizationUnit>(userId?'SELECT * FROM rastreia.organization_units($1)':
    `SELECT store.id,store.name,store.tenant_id,tenant.name AS tenant_name,store.company_id,company.name AS company_name
     FROM stores store JOIN companies company ON company.id=store.company_id JOIN tenants tenant ON tenant.id=store.tenant_id ORDER BY tenant.name,company.name,store.name`,userId?[userId]:[])).rows;
}
export function organizationTree(units:OrganizationUnit[]) {
  return {groups:Array.from(new Map(units.map(u=>[u.tenant_id,{id:u.tenant_id,name:u.tenant_name}])).values()),
    companies:Array.from(new Map(units.map(u=>[u.company_id,{id:u.company_id,tenant_id:u.tenant_id,name:u.company_name}])).values()),
    stores:units.map(u=>({id:u.id,name:u.name,tenant_id:u.tenant_id,company_id:u.company_id}))};
}
export const countKeys=['deliveries','active_deliveries','delivered','failed','late','open_incidents','active_routes','open_shifts'] as const;
export function summarizeOperations(rows:OperationRow[]) {
  const totals=Object.fromEntries(countKeys.map(key=>[key,rows.reduce((sum,row)=>sum+Number(row[key]),0)]));
  return {...totals,units:rows.length,companies:new Set(rows.map(row=>row.company_id)).size,groups:new Set(rows.map(row=>row.tenant_id)).size};
}
export async function operationsReport(client:PoolClient,query:unknown,userId?:string) {
  const filters=operationsFilterSchema.parse(query);
  const permitted=(await scopedUnits(client,userId)).filter(unit=>!userId||unit.role==='TENANT_MANAGER'||unit.role==='STORE_OPERATOR');
  if(userId&&!permitted.length)throw forbidden('Nenhuma unidade de gestão autorizada para esta identidade.');
  if(userId&&((filters.tenantId&&!permitted.some(u=>u.tenant_id===filters.tenantId))||(filters.companyId&&!permitted.some(u=>u.company_id===filters.companyId))
    ||(filters.storeId&&!permitted.some(u=>u.id===filters.storeId))))throw forbidden('Contexto organizacional indisponível.');
  const selected=permitted.filter(unit=>(!filters.tenantId||unit.tenant_id===filters.tenantId)&&(!filters.companyId||unit.company_id===filters.companyId)&&(!filters.storeId||unit.id===filters.storeId));
  if((filters.tenantId||filters.companyId||filters.storeId)&&!selected.length){
    const emptyMasterContext=!userId&&(await client.query(`SELECT 1 FROM tenants tenant LEFT JOIN companies company ON company.tenant_id=tenant.id
      LEFT JOIN stores store ON store.company_id=company.id WHERE ($1::uuid IS NULL OR tenant.id=$1)
      AND ($2::uuid IS NULL OR company.id=$2) AND ($3::uuid IS NULL OR store.id=$3) LIMIT 1`,[filters.tenantId??null,filters.companyId??null,filters.storeId??null])).rowCount;
    if(!emptyMasterContext)throw forbidden('Os filtros não pertencem à mesma estrutura.');
  }
  const rows:OperationRow[]=[];const positions:OperationPosition[]=[];
  for(const tenantId of new Set(selected.map(unit=>unit.tenant_id))) {
    const units=selected.filter(unit=>unit.tenant_id===tenantId);
    if(userId)await setTenantContext(client,{tenantId,userId,storeIds:units.map(unit=>unit.id)});
    const result=await client.query<OperationRow>(`SELECT store.id,store.name,store.tenant_id,tenant.name AS tenant_name,store.company_id,
      company.name AS company_name,store.latitude,store.longitude,
      count(delivery.id)::int AS deliveries,
      count(delivery.id) FILTER(WHERE delivery.status IN ('ASSIGNED','AWAITING_PICKUP','COLLECTED','IN_ROUTE','NEXT_STOP','RETURN_STARTED'))::int AS active_deliveries,
      count(delivery.id) FILTER(WHERE delivery.status='DELIVERED')::int AS delivered,
      count(delivery.id) FILTER(WHERE delivery.status='DELIVERY_FAILED')::int AS failed,
      count(delivery.id) FILTER(WHERE delivery.promised_window_end<COALESCE(delivery.delivered_at,now()) AND delivery.status NOT IN ('CANCELLED','RETURNED'))::int AS late,
      (SELECT count(*)::int FROM incidents incident WHERE incident.store_id=store.id AND incident.status<>'RESOLVED') AS open_incidents,
      (SELECT count(*)::int FROM routes route WHERE route.store_id=store.id AND route.status='ACTIVE' AND ($6::uuid IS NULL OR route.courier_profile_id=$6)) AS active_routes,
      (SELECT count(*)::int FROM shift_positions position JOIN shift_slots slot ON slot.id=position.slot_id WHERE slot.store_id=store.id
        AND slot.status IN ('SCHEDULED','ACTIVE') AND position.status='AVAILABLE') AS open_shifts
      FROM stores store JOIN companies company ON company.id=store.company_id JOIN tenants tenant ON tenant.id=store.tenant_id
      LEFT JOIN deliveries delivery ON delivery.store_id=store.id
        AND delivery.created_at>=($2::date::timestamp AT TIME ZONE $4) AND delivery.created_at<(($3::date+1)::timestamp AT TIME ZONE $4)
        AND ($5::text IS NULL OR delivery.status::text=$5) AND ($6::uuid IS NULL OR delivery.courier_profile_id=$6)
      WHERE store.id=ANY($1::uuid[]) GROUP BY store.id,tenant.id,company.id ORDER BY store.name,store.id`,
      [units.map(unit=>unit.id),filters.from,filters.to,filters.timezone,filters.status??null,filters.courierId??null]);
    rows.push(...result.rows);
    positions.push(...(await client.query<OperationPosition>(`SELECT location.courier_profile_id AS courier_id,location.store_id,location.delivery_id,
      location.latitude,location.longitude,location.captured_at,(location.captured_at<now()-interval '2 minutes') AS stale
      FROM courier_last_locations location JOIN deliveries delivery ON delivery.id=location.delivery_id AND delivery.store_id=location.store_id
      WHERE location.store_id=ANY($1::uuid[]) AND delivery.status IN ('ASSIGNED','AWAITING_PICKUP','COLLECTED','IN_ROUTE','NEXT_STOP','RETURN_STARTED')
      AND delivery.created_at>=($2::date::timestamp AT TIME ZONE $4) AND delivery.created_at<(($3::date+1)::timestamp AT TIME ZONE $4)
      AND ($5::text IS NULL OR delivery.status::text=$5) AND ($6::uuid IS NULL OR location.courier_profile_id=$6)`,
      [units.map(unit=>unit.id),filters.from,filters.to,filters.timezone,filters.status??null,filters.courierId??null])).rows);
  }
  const companies=Array.from(new Set(rows.map(row=>row.company_id))).map(id=>{const subset=rows.filter(row=>row.company_id===id);return {id,name:subset[0]!.company_name,tenantId:subset[0]!.tenant_id,...summarizeOperations(subset)};});
  return {filters,generatedAt:new Date().toISOString(),summary:summarizeOperations(rows),companies,stores:rows,positions};
}
