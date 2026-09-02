import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import type { PoolClient } from 'pg';
import { createIfoodProvider } from './ifood.module.js';
import { IfoodIntegrationService } from './ifood.integration.js';

/** Dedicated worker: PostgreSQL session lock prevents duplicate polling across replicas. */
export function createIfoodWorker(db: Database, env: AppEnv) {
  const service=new IfoodIntegrationService(db,env,createIfoodProvider(db,env));let busy=false;
  return async () => {
    if(!env.IFOOD_ENABLED||busy)return;busy=true;
    let lease:PoolClient|undefined;let acquired=false;
    try{
      lease=await db.connect();
      acquired=(await lease.query<{locked:boolean}>("SELECT pg_try_advisory_lock(73915,35) AS locked")).rows[0]?.locked===true;
      if(!acquired)return;
      await db.query('UPDATE integration_connections SET last_worker_at=now() WHERE enabled AND mode=$1',[env.IFOOD_MODE]);
      await service.poll();
      await service.processEvents();await service.releaseDue();await service.processCommands();
    }finally{
      try{if(acquired)await lease?.query('SELECT pg_advisory_unlock(73915,35)');}
      finally{lease?.release();busy=false;}
    }
  };
}
