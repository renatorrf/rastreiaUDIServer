import type { Database } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
import { expireLiveStore,expiredLivePredicate } from './live.service.js';

// Dedicated maintenance; never enqueue commercial events into the delivery outbox.
export async function expireCommerceLives(db:Database) {
  const stores=await db.query<{store_id:string}>(`SELECT DISTINCT l.store_id FROM rastreia.commerce_live_sessions l WHERE ${expiredLivePredicate} LIMIT 50`);
  for(const row of stores.rows)await withTransaction(db,c=>expireLiveStore(c,row.store_id));
}
