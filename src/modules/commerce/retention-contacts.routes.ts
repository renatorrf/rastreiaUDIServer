import {createHmac} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {Database} from '../../database/pool.js';
import {withTenantTransaction} from '../../database/pool.js';
import type {AppEnv} from '../../config/env.js';
import {authenticate,requireRoles} from '../auth/auth.guard.js';
import {requireCommerceStore} from './commerce.service.js';
import {conflict} from '../../shared/errors.js';
import {parseIdempotencyKey,withIdempotency} from '../../shared/idempotency.js';

// One event per completed order. Catalog-generated deliveries are not a second purchase.
export const contactQuery=`WITH events AS (
 SELECT d.id,retention_delivery_phone(d.origin,d.recipient_whatsapp,d.recipient_phone) AS phone,
 d.recipient_name AS name,d.created_at AS ordered,d.id AS delivery,p.user_id AS uid,NULL::bigint AS revenue
 FROM deliveries d LEFT JOIN customer_profiles p ON p.id=d.customer_profile_id AND p.tenant_id=d.tenant_id AND p.status='ACTIVE'
 WHERE d.store_id=$1 AND d.status='DELIVERED' AND NOT EXISTS(SELECT 1 FROM commerce_orders o WHERE o.delivery_id=d.id AND o.store_id=$1)
 UNION ALL SELECT o.id,retention_phone(o.whatsapp),o.customer_name,o.created_at,NULL::uuid,o.customer_user_id,s.revenue_cents
 FROM commerce_orders o JOIN commerce_finance_sales s ON s.order_id=o.id AND s.store_id=$1 WHERE o.store_id=$1
), contacts AS (
 SELECT phone,(array_agg(id ORDER BY ordered DESC,id))[1] AS id,(array_agg(name ORDER BY ordered DESC,id))[1] AS name,
 (array_agg(delivery ORDER BY ordered DESC,id) FILTER(WHERE delivery IS NOT NULL))[1] AS delivery,
 count(*)::integer AS orders,sum(revenue)::float8 AS revenue,
 (now() AT TIME ZONE 'America/Sao_Paulo')::date-(max(ordered) AT TIME ZONE 'America/Sao_Paulo')::date AS days,
 round(((max(ordered) AT TIME ZONE 'America/Sao_Paulo')::date-(min(ordered) AT TIME ZONE 'America/Sao_Paulo')::date)::numeric/nullif(count(*)-1,0),1)::float8 AS cadence,
 bool_or(uid IS NOT NULL) AS linked FROM events WHERE phone IS NOT NULL GROUP BY phone
) SELECT c.*,c.linked OR EXISTS(SELECT 1 FROM customer_profiles cp JOIN stores s ON s.tenant_id=cp.tenant_id
 WHERE s.id=$1 AND cp.status='ACTIVE' AND cp.user_id IS NOT NULL AND retention_phone(cp.whatsapp_normalized)=c.phone) AS registered,
 pc.id AS consent,coalesce(pc.enabled,false) AS permitted,retention_contact_blocked($1,c.delivery) AS blocked,
 EXISTS(SELECT 1 FROM retention_phone_consents old JOIN retention_offers o ON o.phone_consent_id=old.id
 WHERE old.store_id=$1 AND old.whatsapp=c.phone AND o.expires_at>now()) AS recently_offered
 FROM contacts c LEFT JOIN LATERAL(SELECT id,enabled FROM retention_phone_consents WHERE store_id=$1 AND whatsapp=c.phone ORDER BY id DESC LIMIT 1) pc ON true`;

const productSql=`SELECT p.id,p.name,f.slug,s.name AS store_name FROM commerce_products p JOIN commerce_storefronts f ON f.store_id=p.store_id
 JOIN stores s ON s.id=p.store_id LEFT JOIN commerce_categories k ON k.id=p.category_id
 WHERE p.store_id=$1 AND f.published AND commerce_public_store(f.slug) IS NOT NULL AND p.active AND p.published AND (k.id IS NULL OR k.active)
 AND EXISTS(SELECT 1 FROM commerce_variants v LEFT JOIN commerce_inventory_balances b ON b.variant_id=v.id WHERE v.product_id=p.id
 AND v.active AND v.price_cents>0 AND (p.stock_mode='MADE_TO_ORDER' OR b.on_hand>b.reserved))`;
const params=z.object({storeId:z.uuid(),id:z.uuid().optional()});
const criteria=z.object({inactiveDays:z.coerce.number().int().min(1).max(365),minOrders:z.coerce.number().int().min(1).max(100)});
const proof=z.object({kind:z.literal('permission'),enabled:z.boolean(),reference:z.string().trim().min(3).max(160)});
const issue=z.object({kind:z.literal('offer'),productId:z.uuid(),percent:z.number().int().min(1).max(100),validDays:z.number().int().min(1).max(30)}).extend(criteria.shape);
export async function retentionContactRoutes(app:FastifyInstance,db:Database,env:AppEnv){
 const base='/commerce/stores/:storeId/retention/contacts',preHandler=[authenticate(env,db),requireRoles('TENANT_MANAGER')];
 const key=(unit:string,phone:string)=>createHmac('sha256',env.TRACKING_TOKEN_PEPPER).update(unit+':retention:'+phone).digest('hex');
 app.get(base,{preHandler},async(req,reply)=>{
   const {storeId}=params.parse(req.params),q=criteria.extend({offset:z.coerce.number().int().min(0).max(1000000).default(0)}).parse(req.query);
   reply.header('Cache-Control','no-store');
   return withTenantTransaction(db,req.auth,async c=>{await requireCommerceStore(c,storeId);
     const {rows}=await c.query(`WITH report AS (${contactQuery}) SELECT (SELECT count(*)::int FROM report) AS total,
       (SELECT count(*)::int FROM report WHERE NOT registered) AS guests,
       coalesce((SELECT json_agg(page ORDER BY days DESC,id) FROM (SELECT * FROM report ORDER BY days DESC,id LIMIT 30 OFFSET $2) page),'[]') AS entries`,[storeId,q.offset]);
     const r=rows[0]!;return {total:r.total,guests:r.guests,enabled:env.WHATSAPP_OFFERS_ENABLED,data:r.entries.map((x:{id:string;name:string;phone:string;orders:number;days:number;cadence:number|null;revenue:number|null;registered:boolean;permitted:boolean;blocked:boolean;recently_offered:boolean})=>({
       id:x.id,key:key(storeId,x.phone),name:x.name,ending:x.phone.slice(-4),orders:x.orders,days:x.days,cadence:x.cadence,revenue:x.revenue,registered:x.registered,
       permitted:x.permitted&&!x.blocked,blocked:x.blocked,recentlyOffered:x.recently_offered,eligible:x.days>=q.inactiveDays&&x.orders>=q.minOrders
     }))};
   });
 });
 app.get(base+'/products',{preHandler},async(req,reply)=>{
   const {storeId}=params.parse(req.params),{search}=z.object({search:z.string().trim().max(100).default('')}).parse(req.query);reply.header('Cache-Control','no-store');
   return withTenantTransaction(db,req.auth,async c=>{await requireCommerceStore(c,storeId);return {data:(await c.query(productSql+" AND strpos(lower(p.name),lower($2))>0 ORDER BY p.name,p.id LIMIT 40",[storeId,search])).rows.map(x=>({id:x.id,name:x.name}))};});
 });
 app.post(base+'/:id',{preHandler},async(req,reply)=>{
   const {storeId,id}=params.required().parse(req.params),input=z.discriminatedUnion('kind',[proof,issue]).and(z.object({key:z.string().length(64)})).parse(req.body);
   const response=await withTenantTransaction(db,req.auth,async c=>{await requireCommerceStore(c,storeId);
     return withIdempotency(c,req.auth,parseIdempotencyKey(req.headers['idempotency-key']),'retention.contact',{storeId,id,...input},async()=>{
       await c.query("SELECT pg_advisory_xact_lock(hashtext('retention:'||$1))",[storeId]);
       const x=(await c.query(contactQuery+' WHERE c.id=$2',[storeId,id])).rows[0];
       if(!x||x.registered||!x.delivery||key(storeId,x.phone)!==input.key)throw conflict('O contato mudou ou já possui conta. Atualize a lista.');
       if(input.kind==='permission'){
         if(x.blocked&&input.enabled)throw conflict('O cliente bloqueou ofertas no WhatsApp.');
         await c.query('INSERT INTO retention_phone_consents(store_id,whatsapp,enabled,proof_ref,actor_id) VALUES($1,$2,$3,$4,$5)',[storeId,x.phone,input.enabled,input.reference,req.auth.userId]);
       }else{
         if(!env.WHATSAPP_OFFERS_ENABLED||!x.permitted||x.blocked||x.days<input.inactiveDays||x.orders<input.minOrders)throw conflict('Confira a autorização, o canal e os critérios do público.');
         if((await c.query('SELECT 1 FROM retention_offers o JOIN retention_phone_consents pc ON pc.id=o.phone_consent_id WHERE o.store_id=$1 AND pc.whatsapp=$2 AND o.expires_at>now()',[storeId,x.phone])).rowCount)throw conflict('Este telefone já recebeu uma oferta no período.');
         const p=(await c.query(productSql+' AND p.id=$2',[storeId,input.productId])).rows[0];if(!p)throw conflict('Escolha um produto disponível no catálogo.');
         await c.query(`INSERT INTO retention_offers(store_id,approved_by,product_id,product_name,store_name,slug,first_name,percent,expires_at,dispatch,phone_consent_id,source_delivery_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+make_interval(days=>$9),'QUEUED',$10,$11)`,[storeId,req.auth.userId,p.id,p.name,p.store_name,p.slug,x.name.trim().split(/\s+/)[0]||'Cliente',input.percent,input.validDays,x.consent,x.delivery]);
       }
       return {statusCode:200,body:{ok:true}};
     });
   });return reply.header('Cache-Control','no-store').code(response.statusCode).send(response.body);
 });
}
