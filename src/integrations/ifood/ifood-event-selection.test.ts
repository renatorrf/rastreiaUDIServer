import { PGlite } from '@electric-sql/pglite';
import { describe,expect,it,vi } from 'vitest';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import type { ExternalOrderProvider } from '../external-orders/external-order-provider.js';
import { IfoodIntegrationService } from './ifood.integration.js';

describe('iFood pending event SQL',()=>{
 it('uses a numeric batch limit and selects matching company modes, not the global mode',async()=>{
  const pg=new PGlite();
  try{
   await pg.exec(`
    CREATE TABLE integration_connections(id text PRIMARY KEY,merchant_id text,provider text,mode text,enabled boolean,auto_import_orders boolean);
    CREATE TABLE integration_events(id text PRIMARY KEY,integration_id text,merchant_id text,provider text,mode text,status text,
      attempts integer DEFAULT 0,next_attempt_at timestamptz DEFAULT now(),last_error text,external_order_id text,
      event_created_at timestamptz DEFAULT now(),received_at timestamptz DEFAULT now());
    CREATE TABLE external_orders(integration_id text,external_order_id text);
    INSERT INTO integration_connections VALUES
      ('sandbox','m1','IFOOD','sandbox',true,true),('production','m2','IFOOD','production',true,true),
      ('disabled','m3','IFOOD','sandbox',false,true),('existing','m4','IFOOD','production',true,false);
    INSERT INTO external_orders VALUES('existing','old-order');
    INSERT INTO integration_events(id,integration_id,merchant_id,provider,mode,status,external_order_id) VALUES
      ('sandbox-event','sandbox','m1','IFOOD','sandbox','RECEIVED','s-order'),
      ('production-event','production','m2','IFOOD','production','ERROR','p-order'),
      ('disabled-event','disabled','m3','IFOOD','sandbox','RECEIVED','d-order'),
      ('wrong-mode','sandbox','m1','IFOOD','production','RECEIVED','wrong-order'),
      ('other-provider',NULL,'other','OTHER','sandbox','RECEIVED','other-order'),
      ('unmatched',NULL,'unknown','IFOOD','sandbox','RECEIVED','unknown-order'),
      ('existing-order','existing','m4','IFOOD','production','RECEIVED','old-order'),
      ('new-order','existing','m4','IFOOD','production','RECEIVED','new-order'),
      ('finished','sandbox','m1','IFOOD','sandbox','PROCESSED','finished-order'),
      ('exhausted','sandbox','m1','IFOOD','sandbox','ERROR','exhausted-order'),
      ('future','sandbox','m1','IFOOD','sandbox','RECEIVED','future-order');
    UPDATE integration_events SET attempts=5 WHERE id='exhausted';
    UPDATE integration_events SET next_attempt_at=now()+interval '1 hour' WHERE id='future';
   `);
   let selected:string[]=[];
   const query=vi.fn(async(sql:string,params?:unknown[])=>{
    const result=await pg.query<{id:string}>(sql,params);
    // Exercise the real selection SQL only; do not invoke provider calls or process orders.
    if(sql.startsWith('SELECT e.*')){selected=result.rows.map(row=>row.id);return {rows:[]};}
    return result;
   });
   const getOrder=vi.fn();
   const provider={getOrder} as unknown as ExternalOrderProvider;
   const service=new IfoodIntegrationService({query} as unknown as Database,
    {IFOOD_MODE:'mock',TRACKING_TOKEN_PEPPER:'synthetic-test-secret'} as AppEnv,provider);
   await expect(service.processEvents()).resolves.toBe(0);
   expect(selected.sort()).toEqual(['existing-order','production-event','sandbox-event','unmatched']);
   await service.processEvents(2);
   expect(selected).toHaveLength(2);
   expect(getOrder).not.toHaveBeenCalled();
  }finally{await pg.close();}
 },15000);
});
