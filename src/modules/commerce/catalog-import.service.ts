import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { AuthContext } from '../auth/auth.types.js';
import { AppError,conflict,notFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { productSchema } from './commerce.schemas.js';
import { requireCommerceStore,saveCategory,saveProduct } from './commerce.service.js';
import { adjustInventory } from './inventory.service.js';
import { importCents,type CatalogFile } from './catalog-file.js';
export const importFields=['sku','barcode','name','description','category','price','cost','active','stock'] as const;
export const importOptionsSchema=z.object({
  mapping:z.partialRecord(z.enum(importFields),z.number().int().min(0).max(29).nullable()),
  matchKey:z.enum(['sku','barcode']),mode:z.enum(['insert','update','upsert']),skipRows:z.array(z.number().int().min(2).max(101)).max(100).default([]),
}).strict();
export type ImportOptions=z.infer<typeof importOptionsSchema>;
type ProductInput=z.infer<typeof productSchema>;
interface Existing {id:string;name:string;sku:string;barcode:string|null;description:string;category_id:string|null;price_cents:number;cost_cents:number;active:boolean;version:number;variant_id:string;stock_version:number;on_hand:number;reserved:number}
export interface ImportRow {line:number;sku:string;name:string;action:'INSERT'|'UPDATE'|'IGNORE'|'ERROR';errors:string[];input?:ProductInput;productId?:string;version?:number;stock?:number;stockVersion?:number;onHand?:number;variantId?:string;categoryName?:string;categoryVersion?:number}
export interface ImportJob {id:string;store_id:string;state:'DRAFT'|'PREVIEW'|'APPLIED';file_name:string;source:CatalogFile;preview:ImportRow[]|null;options:ImportOptions|null;preview_token:string|null;preview_expires_at:Date|null;result:Record<string,number>|null;created_at:Date}
export async function loadImport(c:PoolClient,store:string,id:string,lock=false){
  await requireCommerceStore(c,store);const job=(await c.query<ImportJob>(`SELECT * FROM commerce_import_jobs WHERE id=$1 AND store_id=$2${lock?' FOR UPDATE':''}`,[id,store])).rows[0];
  if(!job)throw notFound();return job;
}
export const importView=(job:ImportJob)=>({id:job.id,state:job.state,fileName:job.file_name,columns:job.source.columns,sample:job.source.rows.slice(0,5),rowCount:job.source.rows.length,preview:job.preview,options:job.options,previewToken:job.preview_token,result:job.result});
export async function buildImportPreview(c:PoolClient,store:string,source:CatalogFile,options:ImportOptions):Promise<ImportRow[]>{
  for(const field of ['sku','name','price',options.matchKey] as const)if(options.mapping[field]==null)throw conflict(`Mapeie a coluna ${field}.`);
  const mapped=Object.values(options.mapping).filter((n):n is number=>n!=null);
  if(new Set(mapped).size!==mapped.length||mapped.some(n=>n>=source.columns.length))throw conflict('Cada campo deve usar uma coluna válida e diferente.');
  const value=(cells:string[],field:typeof importFields[number])=>{const index=options.mapping[field];return index==null?undefined:cells[index]??'';};
  const skus=source.rows.map(row=>(value(row,'sku')??'').toLowerCase()),barcodes=source.rows.map(row=>value(row,'barcode')??'');
  const existing=(await c.query<Existing>(`SELECT p.*,v.id AS variant_id,b.version AS stock_version,b.on_hand,b.reserved FROM commerce_products p
    JOIN commerce_variants v ON v.product_id=p.id AND v.is_default JOIN commerce_inventory_balances b ON b.variant_id=v.id
    WHERE p.store_id=$1 AND (lower(p.sku)=ANY($2::text[]) OR p.barcode=ANY($3::text[])) ORDER BY p.id`,[store,skus,barcodes])).rows;
  const categories=(await c.query<{id:string;name:string;active:boolean;version:number}>('SELECT id,name,active,version FROM commerce_categories WHERE store_id=$1 AND lower(name)=ANY($2::text[])',[store,source.rows.map(row=>(value(row,'category')??'').toLowerCase())])).rows;
  const variantSkus=(await c.query<{sku:string;product_id:string}>('SELECT sku,product_id FROM commerce_variants WHERE store_id=$1 AND lower(sku)=ANY($2::text[]) AND NOT is_default',[store,skus])).rows;
  const seenSku=new Set<string>(),seenBarcode=new Set<string>(),seenProducts=new Set<string>();
  return source.rows.map((cells,index)=>{
    const line=index+2,sku=value(cells,'sku')??'',name=value(cells,'name')??'',barcode=value(cells,'barcode');
    const row:ImportRow={line,sku,name,action:'ERROR',errors:[]};
    if(options.skipRows.includes(line)){row.action='IGNORE';return row;}
    try {
      if(seenSku.has(sku.toLowerCase())||(barcode&&seenBarcode.has(barcode)))throw conflict('Código repetido no arquivo.');
      seenSku.add(sku.toLowerCase());if(barcode)seenBarcode.add(barcode);
      const current=existing.find(p=>options.matchKey==='sku'?p.sku.toLowerCase()===sku.toLowerCase():p.barcode===barcode);
      if(current&&seenProducts.has(current.id))throw conflict('Mais de uma linha corresponde ao mesmo produto.');if(current)seenProducts.add(current.id);
      if(options.matchKey==='barcode'&&!barcode)throw conflict('Informe o código de barras usado como chave.');
      if(existing.some(p=>p.id!==current?.id&&(p.sku.toLowerCase()===sku.toLowerCase()||(barcode&&p.barcode===barcode)))||variantSkus.some(v=>v.sku.toLowerCase()===sku.toLowerCase()))throw conflict('SKU ou código de barras já utilizado por outro produto/variante.');
      if((current&&options.mode==='insert')||(!current&&options.mode==='update')){row.action='IGNORE';return row;}
      const categoryName=value(cells,'category'),category=categoryName?categories.find(cat=>cat.name.toLowerCase()===categoryName.toLowerCase()):undefined;
      if(category&&!category.active)throw conflict('A categoria está arquivada.');
      if(categoryName&&(categoryName.length<2||categoryName.length>100))throw conflict('Categoria deve ter de 2 a 100 caracteres.');
      const activeText=value(cells,'active')?.toLowerCase();
      if(activeText!==undefined&&!['sim','não','nao','true','false','1','0','ativo','inativo'].includes(activeText))throw conflict('Ativo deve ser sim ou não.');
      row.input=productSchema.parse({sku,name,barcode:barcode===undefined?(current?.barcode??null):(barcode||null),
        description:value(cells,'description')??current?.description??'',categoryId:categoryName===undefined?(current?.category_id??null):(category?.id??null),
        priceCents:importCents(value(cells,'price')??''),costCents:value(cells,'cost')===undefined?(current?.cost_cents??0):importCents(value(cells,'cost')!),
        active:activeText===undefined?(current?.active??true):['sim','true','1','ativo'].includes(activeText)});
      if(categoryName){row.categoryName=categoryName;if(category)row.categoryVersion=category.version;}
      const stock=value(cells,'stock');
      if(stock!==undefined){if(!/^\d{1,7}$/.test(stock)||Number(stock)>1_000_000||Number(stock)<(current?.reserved??0))throw conflict('Estoque deve ser inteiro, de 0 a 1.000.000, e não inferior ao reservado.');row.stock=Number(stock);}
      if(current){row.productId=current.id;row.version=current.version;if(stock!==undefined){row.stockVersion=current.stock_version;row.onHand=current.on_hand;row.variantId=current.variant_id;}}
      row.action=current?'UPDATE':'INSERT';
    }catch(error){row.errors=[error instanceof z.ZodError?error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join(' · '):error instanceof AppError?error.message:'Dados inválidos.'];}
    return row;
  });
}
export function importCounts(rows:ImportRow[]){return {inserted:rows.filter(r=>r.action==='INSERT').length,updated:rows.filter(r=>r.action==='UPDATE').length,ignored:rows.filter(r=>r.action==='IGNORE').length,errors:rows.filter(r=>r.action==='ERROR').length};}
export async function previewImport(c:PoolClient,store:string,id:string,options:ImportOptions){
  const job=await loadImport(c,store,id,true);if(job.state==='APPLIED')throw conflict('Este arquivo já foi aplicado. Consulte o resultado.');
  const rows=await buildImportPreview(c,store,job.source,options),token=randomUUID();
  await c.query(`UPDATE commerce_import_jobs SET state='PREVIEW',options=$2,preview=$3,preview_token=$4,preview_expires_at=now()+interval '30 minutes' WHERE id=$1`,[id,JSON.stringify(options),JSON.stringify(rows),token]);
  return importView({...job,state:'PREVIEW',options,preview:rows,preview_token:token});
}
export async function applyImport(c:PoolClient,auth:AuthContext,store:string,id:string,token:string,reason:string){
  const job=await loadImport(c,store,id,true);if(job.state==='APPLIED')return importView(job);
  if(job.state!=='PREVIEW'||job.preview_token!==token||!job.options||!job.preview||new Date(job.preview_expires_at!).getTime()<Date.now())throw conflict('A prévia expirou ou mudou. Gere uma nova prévia.');
  // Serialize imports and lock products. Balance writes remain exclusive to the controlled SQL function.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`catalog-import:${store}`]);
  const productIds=job.preview.flatMap(r=>r.productId?[r.productId]:[]);
  await c.query('SELECT id FROM commerce_products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[productIds]);
  await c.query('SELECT id FROM commerce_categories WHERE store_id=$1 ORDER BY id FOR SHARE',[store]);
  const current=await buildImportPreview(c,store,job.source,job.options);
  if(!isDeepStrictEqual(current,job.preview))throw conflict('O catálogo ou estoque mudou desde a prévia. Revise novamente antes de confirmar.');
  if(current.some(r=>r.action==='ERROR'))throw conflict('Corrija ou marque para ignorar as linhas com erros.');
  const categories=new Map<string,string>();
  for(const row of current){
    if(row.action==='IGNORE')continue;const input={...row.input!};
    if(row.categoryName&&!input.categoryId){const key=row.categoryName.toLowerCase();let categoryId=categories.get(key);
      if(!categoryId){categoryId=String((await saveCategory(c,auth,store,{name:row.categoryName,active:true})).id);categories.set(key,categoryId);}input.categoryId=categoryId;
    }
    const product=await saveProduct(c,auth,store,input,row.productId,row.version);
    if(row.stock!==undefined){const balance=(await c.query<{variant_id:string;version:number;on_hand:number}>(`SELECT b.variant_id,b.version,b.on_hand FROM commerce_inventory_balances b JOIN commerce_variants v ON v.id=b.variant_id WHERE v.product_id=$1 AND v.is_default`,[product.id])).rows[0]!;
      if(row.stockVersion!==undefined&&balance.version!==row.stockVersion)throw conflict('O estoque mudou. Gere uma nova prévia.');
      // Imported opening/received stock is not an inventory surplus (DRE revenue).
      // Only an explicitly mapped cost can value the incoming units; defaults are unknown.
      const delta=row.stock-balance.on_hand;if(delta)await adjustInventory(c,auth,store,{variantId:balance.variant_id,expectedVersion:row.stockVersion??balance.version,delta,kind:delta>0?'ENTRY':'ADJUSTMENT',reason:`Importação ${id}: ${reason}`.slice(0,500),...(delta>0&&job.options.mapping.cost!=null?{unitCostCents:input.costCents}:{})});
    }
  }
  const result=importCounts(current);await c.query("UPDATE commerce_import_jobs SET state='APPLIED',result=$2,applied_at=now() WHERE id=$1",[id,JSON.stringify(result)]);
  await writeAudit(c,{tenantId:auth.tenantId,actorUserId:auth.userId,action:'commerce.catalog.imported',entityType:'commerce_import',entityId:id,afterData:{...result,reason}});
  return importView({...job,state:'APPLIED',result});
}
