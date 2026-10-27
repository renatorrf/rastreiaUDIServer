import type { PoolClient } from 'pg';
import { setTenantContext,withTransaction,type Database } from '../../database/pool.js';
import type { AuthContext } from '../auth/auth.types.js';
import { createDeliveryInTransaction,type CreateDeliveryInput } from '../deliveries/delivery.service.js';

interface FulfillmentOrder {
 id:string;tenant_id:string;store_id:string;approved_by:string;number:string;customer_name:string;whatsapp:string;
 address: {addressLine:string;addressNumber:string;complement?:string;neighborhood?:string;city:string;state:string;postalCode?:string;latitude:number;longitude:number};
 payment_method:string;total_cents:string;delivery_id:string|null;
}

/** Trusted worker only. Store + order locks serialize retries with approval/cancellation.
 * Creation and link commit together; no completed HTTP request is needed for recovery. */
export async function fulfillCommerceOrder(client:PoolClient,id:string,create=createDeliveryInTransaction){
 const lookup=(await client.query<{store_id:string}>('SELECT store_id FROM commerce_orders WHERE id=$1',[id])).rows[0];
 if(!lookup)return;
 await client.query("SELECT pg_advisory_xact_lock(hashtext('commerce-orders:'||$1))",[lookup.store_id]);
 const order=(await client.query<FulfillmentOrder>(`SELECT *,subtotal_cents+delivery_fee_cents AS total_cents FROM commerce_orders
  WHERE id=$1 AND flow_version=2 AND status='CONFIRMED' AND fulfillment='DELIVERY' AND approved_by IS NOT NULL
  AND (payment_method='CARD_PRESENT' OR EXISTS(SELECT 1 FROM commerce_pix_payments p WHERE p.order_id=commerce_orders.id AND p.status='PAID')) FOR UPDATE`,[id])).rows[0];
 if(!order)return;
 const auth:AuthContext={tenantId:order.tenant_id,userId:order.approved_by,role:'TENANT_MANAGER',storeIds:[order.store_id],sessionId:'commerce-fulfillment'};
 await setTenantContext(client,auth);
 if(order.delivery_id){
  const delivery=(await client.query<{status:string}>(`SELECT status FROM deliveries WHERE id=$1 AND tenant_id=$2 AND store_id=$3 FOR SHARE`,[order.delivery_id,order.tenant_id,order.store_id])).rows[0];
  if(delivery?.status==='DELIVERED'||delivery?.status==='CANCELLED'){
   await client.query('SELECT commerce_apply_approved_state($1,$2,$3,$4)',[id,delivery.status==='DELIVERED'?'COMPLETED':'CANCELLED',
    delivery.status==='DELIVERED'?'Entrega concluída na operação.':'Entrega cancelada na operação; itens devolvidos ao estoque.',order.approved_by]);
  }
 }else{
  const a=order.address;
  if(!a||!Number.isFinite(Number(a.latitude))||!Number.isFinite(Number(a.longitude))||!a.addressLine||!a.city||!a.state)throw new Error('Commerce delivery address incomplete');
  const items=(await client.query<{quantity:number;product_name:string;variant_name:string;attributes:{size?:string;color?:string};preparation_notes:string}>(
   'SELECT quantity,product_name,variant_name,attributes,preparation_notes FROM commerce_order_items WHERE order_id=$1 ORDER BY product_name,variant_id',[id])).rows;
  const payment=order.payment_method==='PIX'?'PIX PAGO — não cobrar novamente.':`COBRAR NA MAQUININHA: R$ ${(Number(order.total_cents)/100).toFixed(2).replace('.',',')}. Levar maquininha.`;
  const summary=items.map(i=>`${i.quantity}x ${i.product_name} (${[i.variant_name,i.attributes.size,i.attributes.color].filter(Boolean).join(' · ')})${i.preparation_notes?' — '+i.preparation_notes:''}`).join('\n');
  const instructions=`Pedido catálogo #${order.number}\n${payment}\n${summary}`;
  const input:CreateDeliveryInput={storeId:order.store_id,externalReference:`CAT-${order.number}`,recipientName:order.customer_name.slice(0,160),
   recipientPhone:order.whatsapp,recipientWhatsapp:order.whatsapp,addressLine:a.addressLine,addressNumber:a.addressNumber,complement:a.complement,
   neighborhood:a.neighborhood,city:a.city,state:a.state,postalCode:a.postalCode,latitude:Number(a.latitude),longitude:Number(a.longitude),
   deliveryInstructions:instructions.length>1000?`${instructions.slice(0,930)}\nResumo parcial: confira todos os itens com a loja.`:instructions};
  const delivery=await create(client,auth,input);
  await client.query('UPDATE commerce_orders SET delivery_id=$2,version=version+1,updated_at=now() WHERE id=$1',[id,delivery.id]);
  await client.query("INSERT INTO commerce_order_events(order_id,status,reason,actor_user_id) VALUES($1,'CONFIRMED','Entrega criada automaticamente. Disponível para entregador ou rota.',$2)",[id,order.approved_by]);
 }
 await client.query("UPDATE commerce_orders SET fulfillment_next_check=now()+interval '15 seconds' WHERE id=$1",[id]);
}

export async function maintainCommerceFulfillment(db:Database){
 const rows=await db.query<{id:string}>(`SELECT id FROM commerce_orders WHERE flow_version=2 AND status='CONFIRMED' AND fulfillment='DELIVERY'
  AND fulfillment_next_check<=now() ORDER BY fulfillment_next_check,id LIMIT 30`);
 for(const row of rows.rows){
  try{await withTransaction(db,c=>fulfillCommerceOrder(c,row.id));}
  catch{
   // Bounded backoff avoids a bad address starving later valid orders. No customer/provider data in logs.
   await db.query("UPDATE commerce_orders SET fulfillment_next_check=now()+interval '30 seconds' WHERE id=$1",[row.id]);
   process.stderr.write('commerce fulfillment: pending delivery will be retried\n');
  }
 }
}
