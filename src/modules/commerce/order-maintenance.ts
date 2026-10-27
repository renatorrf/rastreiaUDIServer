import type { Database } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
// Dedicated maintenance, not the delivery outbox: old notification workers cannot consume commerce events.
export async function expireCommerceOrders(db:Database){
  const stores=await db.query<{store_id:string}>("SELECT DISTINCT store_id FROM rastreia.commerce_orders WHERE (status='WAITING_PAYMENT' OR (status='RECEIVED' AND payment_method='ARRANGE')) AND reservation_expires_at<=now() LIMIT 50");
  for(const store of stores.rows)await withTransaction(db,c=>c.query('SELECT rastreia.commerce_expire_store_orders($1)',[store.store_id]));
}
