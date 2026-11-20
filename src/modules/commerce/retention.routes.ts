import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {authenticate,requireRoles} from '../auth/auth.guard.js';
import {withTenantTransaction,type Database} from '../../database/pool.js';
import type {AppEnv} from '../../config/env.js';
import {requireCommerceStore} from './commerce.service.js';
import {conflict} from '../../shared/errors.js';
import {parseIdempotencyKey,withIdempotency} from '../../shared/idempotency.js';

const fields=z.object({inactiveDays:z.number().int().min(1).max(365),minOrders:z.number().int().min(1).max(100),
  benefit:z.enum(['DISCOUNT','GIFT']),discountPercent:z.number().int().min(1).max(100).nullable(),validDays:z.number().int().min(1).max(30)}).strict()
  .refine(r=>(r.benefit==='DISCOUNT')===(r.discountPercent!==null));
const defaults={inactiveDays:30,minOrders:2,benefit:'DISCOUNT',discountPercent:10,validDays:7};
export const retentionSql=`WITH sales AS (
 SELECT o.id,o.customer_user_id uid,o.customer_name,o.created_at,s.revenue_cents,
 (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS order_day FROM commerce_orders o
 JOIN commerce_finance_sales s ON s.order_id=o.id AND s.store_id=o.store_id WHERE o.store_id=$1
), customers AS (
 SELECT uid,(array_agg(customer_name ORDER BY created_at DESC,id))[1] AS name,count(*)::int orders,
 sum(revenue_cents)::float8 revenue,(now() AT TIME ZONE 'America/Sao_Paulo')::date-max(order_day) AS days,
 round((max(order_day)-min(order_day))::numeric/nullif(count(*)-1,0),1)::float8 cadence FROM sales GROUP BY uid
), products AS (
 SELECT s.uid,v.product_id,(array_agg(i.product_name ORDER BY s.created_at DESC,i.variant_id))[1] AS name,sum(i.quantity)::int units,
 row_number() OVER(PARTITION BY s.uid ORDER BY sum(i.quantity) DESC,max(s.created_at) DESC,v.product_id) rank
 FROM sales s JOIN commerce_order_items i ON i.order_id=s.id AND i.store_id=$1 JOIN commerce_variants v ON v.id=i.variant_id
 GROUP BY s.uid,v.product_id
), registered AS (
 SELECT customer_user_id uid FROM commerce_orders WHERE store_id=$1
 UNION SELECT p.user_id FROM customer_profiles p JOIN deliveries d ON d.customer_profile_id=p.id AND d.tenant_id=p.tenant_id
 WHERE d.store_id=$1 AND p.user_id IS NOT NULL AND p.status='ACTIVE'
), audience AS (
 SELECT * FROM customers WHERE NOT $4::boolean OR (days >= $2 AND orders >= $3)
), page AS (
 SELECT a.*,coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.product_id,'name',p.name,'units',p.units) ORDER BY rank)
 FROM products p WHERE p.uid=a.uid AND rank<=3),'[]') favorites FROM audience a ORDER BY days DESC,uid LIMIT 30 OFFSET $5
) SELECT (SELECT count(*)::int FROM registered) registered,(SELECT count(*)::int FROM customers) buyers,
 (SELECT coalesce(sum(revenue),0)::float8 FROM customers) revenue,(SELECT count(*)::int FROM customers WHERE days >= $2 AND orders >= $3) candidates,
 (SELECT count(*)::int FROM audience) total,coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY days DESC,uid) FROM page),'[]') AS rows`;
export async function retentionRoutes(app:FastifyInstance,db:Database,env:AppEnv){
 const manager=[authenticate(env,db),requireRoles('TENANT_MANAGER')],base='/commerce/stores/:storeId/retention';
 const store=(params:unknown)=>z.object({storeId:z.uuid()}).parse(params).storeId;
 app.post(base+'/offers',{preHandler:manager},async(req,reply)=>{
   const id=store(req.params);
   const input=z.object({rule:fields,offset:z.number().int().min(0).max(1000000),
     recipients:z.array(z.object({uid:z.uuid(),productId:z.uuid()})).min(1).max(30)}).strict().parse(req.body);
   const result=await withTenantTransaction(db,req.auth,async c=>{
     await requireCommerceStore(c,id);
     return withIdempotency(c,req.auth,parseIdempotencyKey(req.headers['idempotency-key']),'retention.issue',{id,...input},async()=>{
       await c.query("SELECT pg_advisory_xact_lock(hashtext('retention:'||$1))",[id]);
       const r=input.rule;
       const shop=(await c.query('SELECT s.name,f.slug FROM stores s JOIN commerce_storefronts f ON f.store_id=s.id WHERE s.id=$1 AND f.published AND commerce_public_store(f.slug) IS NOT NULL',[id])).rows[0];
       if(!shop)throw conflict('Publique o catálogo da unidade antes de criar ofertas.');
       const audience=(await c.query(retentionSql,[id,r.inactiveDays,r.minOrders,true,input.offset])).rows[0]!.rows as {uid:string;name:string;favorites:{id:string}[]}[];
       for(const target of input.recipients){
         const buyer=audience.find(x=>x.uid===target.uid && x.favorites[0]?.id===target.productId);
         if(!buyer)throw conflict('O público mudou. Simule novamente.');
         const product=(await c.query(`SELECT p.name FROM commerce_products p LEFT JOIN commerce_categories k ON k.id=p.category_id
           WHERE p.store_id=$1 AND p.id=$2 AND p.active AND p.published AND (k.id IS NULL OR k.active)
           AND EXISTS(SELECT 1 FROM commerce_variants v JOIN commerce_inventory_balances b ON b.variant_id=v.id
             WHERE v.product_id=p.id AND v.active AND v.price_cents>0 AND (p.stock_mode='MADE_TO_ORDER' OR b.on_hand>b.reserved))`,[id,target.productId])).rows[0];
         if(!product)throw conflict('O produto favorito não está disponível no catálogo.');
         if((await c.query("SELECT id FROM retention_offers WHERE store_id=$1 AND user_id=$2 AND expires_at>now() LIMIT 1",[id,target.uid])).rowCount)
           throw conflict('Um cliente selecionado já recebeu uma oferta neste período.');
         await c.query(`INSERT INTO retention_offers(store_id,user_id,approved_by,product_id,product_name,store_name,slug,first_name,percent,expires_at,dispatch)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+make_interval(days=>$10),CASE WHEN $11 AND EXISTS(
             SELECT 1 FROM retention_preferences WHERE store_id=$1 AND user_id=$2 AND enabled) THEN 'QUEUED' ELSE 'APP' END)`,
           [id,target.uid,req.auth.userId,target.productId,product.name,shop.name,shop.slug,buyer.name.trim().split(/\s+/)[0]||'Cliente',r.benefit==='GIFT'?100:r.discountPercent,r.validDays,env.WHATSAPP_OFFERS_ENABLED]);
       }
       return {statusCode:201,body:{count:input.recipients.length}};
     });
   });return reply.header('Cache-Control','no-store').code(result.statusCode).send(result.body);
 });
 app.get(base,{preHandler:manager},(req,reply)=>{const id=store(req.params);
 const q=z.object({offset:z.coerce.number().int().min(0).max(1000000).default(0),preview:z.enum(['true','false']).default('false'),
 inactiveDays:z.coerce.number().int().min(1).max(365).optional(),minOrders:z.coerce.number().int().min(1).max(100).optional()}).parse(req.query);
 reply.header('Cache-Control','no-store');return withTenantTransaction(db,req.auth,async c=>{await requireCommerceStore(c,id);
 const rule=(await c.query('SELECT inactive_days AS "inactiveDays",min_orders AS "minOrders",benefit,discount_percent AS "discountPercent",valid_days AS "validDays" FROM commerce_retention_rules WHERE store_id=$1',[id])).rows[0]??defaults;
 return {...(await c.query(retentionSql,[id,q.inactiveDays??rule.inactiveDays,q.minOrders??rule.minOrders,q.preview==='true',q.offset])).rows[0],rule};});});
 app.patch(base+'/rule',{preHandler:manager},(req,reply)=>{const id=store(req.params),r=fields.parse(req.body);
 reply.header('Cache-Control','no-store');return withTenantTransaction(db,req.auth,async c=>{await requireCommerceStore(c,id);
 await c.query(`INSERT INTO commerce_retention_rules(store_id,inactive_days,min_orders,benefit,discount_percent,valid_days) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(store_id) DO UPDATE SET inactive_days=excluded.inactive_days,min_orders=excluded.min_orders,benefit=excluded.benefit,discount_percent=excluded.discount_percent,valid_days=excluded.valid_days,updated_at=now()`,[id,r.inactiveDays,r.minOrders,r.benefit,r.discountPercent,r.validDays]);return r;});});
}
