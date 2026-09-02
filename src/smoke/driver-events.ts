import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { io, type Socket } from 'socket.io-client';
import argon2 from 'argon2';
import { buildApp } from '../app.js';
import { loadLocalEnv } from '../config/load-env.js';
import { getEnv } from '../config/env.js';
import { createPool } from '../database/pool.js';
import { createTokenPair } from '../modules/auth/token.service.js';
import { rollbackDatabase } from './rollback-database.js';

loadLocalEnv();const source=getEnv();
if(source.NODE_ENV==='production')throw new Error('Use somente desenvolvimento/teste; todas as fixtures são revertidas.');
const ui=process.argv.includes('--ui'),uiPassword='Synthetic-UI-only-3491!';
const fixtureHash=ui?await argon2.hash(uiPassword):'not-a-login-hash';
const env={...source,NODE_ENV:'test' as const,LOG_LEVEL:'error' as const,REDIS_URL:'',REDIS_REQUIRED:false,COMMUNICATIONS_MOCK:true,
  APP_ORIGINS:source.APP_ORIGINS+',http://localhost:8101'};
const pool=createPool(env),connection=await pool.connect();await connection.query('BEGIN');await connection.query("SET LOCAL lock_timeout='5s'");
const db=rollbackDatabase(pool,connection),prefix='events-'+randomBytes(5).toString('hex');let checks=0;
let app:Awaited<ReturnType<typeof buildApp>>|undefined;const sockets:Socket[]=[];
const check=(value:unknown,message:string)=>{assert.ok(value,message);checks++;};
try {
  if(!(await db.query("SELECT 1 FROM information_schema.tables WHERE table_schema='rastreia' AND table_name='driver_operational_events'")).rowCount)
    await db.query(await readFile('migrations/0034_driver_operational_events.sql','utf8'));
  const masterId=randomUUID();await db.query(`INSERT INTO platform_admins(id,name,email,password_hash) VALUES($1,'Synthetic master',$2,'not-a-login-hash')`,[masterId,prefix+'-master@example.test']);
  await db.query("SELECT set_config('app.platform_admin_id',$1,true)",[masterId]);
  const tenant=randomUUID(),otherTenant=randomUUID(),company=randomUUID(),otherCompany=randomUUID(),store=randomUUID(),sibling=randomUUID(),foreignStore=randomUUID();
  for(const [id,name] of [[tenant,'main'],[otherTenant,'foreign']])await db.query('INSERT INTO tenants(id,name,slug) VALUES($1,$2,$3)',[id,'Synthetic '+name,prefix+'-'+name]);
  for(const [id,tenantId] of [[company,tenant],[otherCompany,otherTenant]])await db.query("INSERT INTO companies(id,tenant_id,name,legal_name) VALUES($1,$2,'Synthetic company','Synthetic company')",[id,tenantId]);
  for(const [id,tenantId,companyId] of [[store,tenant,company],[sibling,tenant,company],[foreignStore,otherTenant,otherCompany]])await db.query(
    `INSERT INTO stores(id,tenant_id,company_id,name,address_line,city,state,latitude,longitude) VALUES($1,$2,$3,'Synthetic unit','Synthetic road','Teste','MG',-18.9,-48.2)`,[id,tenantId,companyId]);
  const managerId=randomUUID(),driverUser=randomUUID(),otherDriverUser=randomUUID(),foreignUser=randomUUID(),driverId=randomUUID(),otherDriverId=randomUUID();
  for(const [id,label] of [[managerId,'manager'],[driverUser,'driver'],[otherDriverUser,'other-driver'],[foreignUser,'foreign-manager']])await db.query(
    `INSERT INTO users(id,name,email,password_hash,email_verified_at) VALUES($1,$2,$3,$4,now())`,[id,'Synthetic '+label,prefix+'-'+label+'@example.test',fixtureHash]);
  for(const [id,tenantId,role] of [[managerId,tenant,'TENANT_MANAGER'],[driverUser,tenant,'COURIER'],[otherDriverUser,tenant,'COURIER'],[foreignUser,otherTenant,'TENANT_MANAGER']])await db.query(
    'INSERT INTO tenant_users(tenant_id,user_id,role) VALUES($1,$2,$3)',[tenantId,id,role]);
  for(const [id,tenantId] of [[managerId,tenant],[foreignUser,otherTenant]])await db.query(
    "INSERT INTO user_access_scopes(tenant_id,user_id,scope_level) VALUES($1,$2,'TENANT')",[tenantId,id]);
  for(const [id,userId] of [[driverId,driverUser],[otherDriverId,otherDriverUser]]){
    await db.query("INSERT INTO courier_profiles(id,user_id,phone,vehicle_type,status) VALUES($1,$2,'34999990000','MOTORCYCLE','ACTIVE')",[id,userId]);
    await db.query("INSERT INTO courier_store_links(tenant_id,store_id,courier_profile_id,status) VALUES($1,$2,$3,'ACTIVE')",[tenant,store,id]);
  }
  const delivery=randomUUID(),secondDelivery=randomUUID(),batch=randomUUID();
  for(const [id,courier] of [[delivery,driverId],[secondDelivery,otherDriverId]])await db.query(`INSERT INTO deliveries(id,tenant_id,store_id,courier_profile_id,status,recipient_name,recipient_phone,address_line,city,state,latitude,longitude)
    VALUES($1,$2,$3,$4,'IN_ROUTE','Synthetic recipient','34999990000','Synthetic road','Teste','MG',-18.91,-48.21)`,[id,tenant,store,courier]);
  const position={eventId:randomUUID(),deliveryId:delivery,latitude:-18.91,longitude:-48.21,accuracy:10,capturedAt:new Date().toISOString()};
  const token=async(userId:string,tenantId:string,storeId:string,role:'TENANT_MANAGER'|'COURIER')=>(await createTokenPair(env,{userId,tenantId,storeIds:[storeId],role})).accessToken;
  const manager=await token(managerId,tenant,store,'TENANT_MANAGER'),driver=await token(driverUser,tenant,store,'COURIER'),otherDriver=await token(otherDriverUser,tenant,store,'COURIER');
  const siblingManager=await token(managerId,tenant,sibling,'TENANT_MANAGER'),foreignManager=await token(foreignUser,otherTenant,foreignStore,'TENANT_MANAGER');
  // All test requests use runtime RLS with serialized savepoints, not the owner connection.
  await db.query("SELECT set_config('app.platform_admin_id','',true)");
  app=await buildApp({env,database:db});const base=await app.listen({port:ui?3000:0,host:'127.0.0.1'});
  const preflight=await app.inject({method:'OPTIONS',url:'/driver-events/'+randomUUID()+'/resolve',headers:{origin:'http://localhost:8101',
    'access-control-request-method':'PATCH','access-control-request-headers':'authorization,content-type,idempotency-key'}});
  check(preflight.statusCode===204&&String(preflight.headers['access-control-allow-methods']).includes('PATCH'),'Browser CORS permits resolution PATCH');
  const call=async(method:'GET'|'POST'|'PATCH',url:string,payload?:unknown,bearer?:string,key=randomUUID())=>{
    const response=await app!.inject({method,url,...(payload===undefined?{}:{payload:payload as object}),headers:{'idempotency-key':key,...(bearer?{authorization:`Bearer ${bearer}`}:{})}});
    return {status:response.statusCode,body:response.json()};
  };
  const connect=async(namespace:string,auth:Record<string,string>)=>{
    const socket=io(base+namespace,{auth,forceNew:true,transports:['websocket'],reconnection:false});sockets.push(socket);
    await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});return socket;
  };
  const next=(socket:Socket,event:string)=>new Promise<unknown>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No socket event: '+event)),5000);
    socket.once(event,payload=>{clearTimeout(timer);resolve(payload);});});
  const shop=await connect('/operations',{accessToken:manager});const otherShop=await connect('/operations',{accessToken:siblingManager});
  const unrelated=await connect('/operations',{accessToken:otherDriver});const own=await connect('/operations',{accessToken:driver});
  let leaked=0;otherShop.on('driver-event:created',()=>leaked++);unrelated.on('driver-event:created',()=>leaked++);
  const location=await call('POST','/courier/location',position,driver);assert.equal(location.status,202,JSON.stringify(location.body));checks++;
  check((await call('GET','/driver-events')).status===401,'Anonymous rejected');
  check((await call('POST','/driver-events',{eventType:'FLAT_TIRE'},manager)).status===403,'Manager cannot impersonate driver');
  check((await call('POST','/driver-events',{eventType:'OTHER'},driver)).status===400,'OTHER requires description');
  check((await call('POST','/driver-events',{eventType:'POLICE_CHECK',customerVisibility:'VISIBLE'},driver)).status===400,'Visibility cannot be forged');
  check((await call('POST','/driver-events',{eventType:'FLAT_TIRE',deliveryId:secondDelivery},driver)).status===404,'Foreign driver delivery rejected');
  const key=randomUUID(),createdNotice=next(shop,'driver-event:created'),ownNotice=next(own,'driver-event:created');
  const created=await call('POST','/driver-events',{eventType:'FLAT_TIRE',description:'Aguardando borracheiro.'},driver,key);
  assert.equal(created.status,201,JSON.stringify(created.body));checks++;
  check((await createdNotice as {id:string}).id===created.body.id,'Store receives creation without GPS/reload');await ownNotice;checks++;
  check(created.body.currentDeliveryId===delivery&&created.body.courierId===driverId&&created.body.scope==='DRIVER','Automatic single operation context');
  check(created.body.latitude===position.latitude&&created.body.locationCapturedAt===position.capturedAt,'Last valid location snapshot');
  check((await call('POST','/driver-events',{eventType:'FLAT_TIRE',description:'Aguardando borracheiro.'},driver,key)).body.id===created.body.id,'Idempotent retry does not duplicate');
  check((await call('POST','/driver-events',{eventType:'FLAT_TIRE'},driver)).status===409,'Duplicate open type rejected');
  check((await call('GET','/driver-events',undefined,siblingManager)).body.data.length===0,'Sibling store RLS');
  check((await call('GET','/driver-events',undefined,foreignManager)).body.data.length===0,'Other tenant RLS');
  check((await call('GET','/driver-events',undefined,otherDriver)).body.data.length===0,'Other courier cannot see event');
  check((await call('PATCH',`/driver-events/${created.body.id}/resolve`,{},siblingManager)).status===404,'Sibling cannot resolve by guessed ID');
  const link=await call('POST',`/deliveries/${delivery}/tracking-link`,{},manager);const publicToken=String(link.body.url).split('/').at(-1)!;
  const publicSocket=await connect('/tracking',{token:publicToken});let publicChanges=0;publicSocket.on('tracking:changed',()=>publicChanges++);
  const police=await call('POST','/driver-events',{eventType:'POLICE_CHECK',description:'INTERNAL-SYNTHETIC-NOTE'},driver);
  assert.equal(police.status,201,JSON.stringify(police.body));checks++;
  const publicView=await call('GET',`/public/tracking/${publicToken}`);
  check(publicView.body.operationalNotices.length===1&&publicView.body.etaSubjectToChange,'Generic public projection only');
  check(!JSON.stringify(publicView.body).includes('INTERNAL-SYNTHETIC-NOTE')&&!JSON.stringify(publicView.body).includes('POLICE_CHECK'),'No internal details to customer');
  const resolvedNotice=next(shop,'driver-event:resolved'),publicNotice=next(publicSocket,'tracking:changed');
  const closed=await call('PATCH',`/driver-events/${created.body.id}/resolve`,{},driver);
  assert.equal(closed.status,200,JSON.stringify(closed.body));await resolvedNotice;await publicNotice;checks++;
  check(closed.body.resolvedByUserId===driverUser&&closed.body.resolvedAt&&closed.body.latitude===position.latitude,'Resolution actor/time and fixed location');
  await call('PATCH',`/driver-events/${police.body.id}/resolve`,{},manager);
  check(publicChanges===1,'Internal police event never emits public changes');
  check((await call('GET',`/driver-events?deliveryId=${delivery}`,undefined,manager)).body.timeline.length===4,'Create and resolve automatically in timeline');
  // GPS still accepts updates; event location stays immutable.
  const moved={...position,eventId:randomUUID(),latitude:-18.9101,capturedAt:new Date(Date.parse(position.capturedAt)+5000).toISOString()};
  check((await call('POST','/courier/location',moved,driver)).status===202,'GPS ingestion continues after occurrences');
  check((await db.query('SELECT status FROM deliveries WHERE id=$1',[delivery])).rows[0].status==='IN_ROUTE','No automatic transition');
  check((await db.query('SELECT latitude FROM driver_operational_events WHERE id=$1',[created.body.id])).rows[0].latitude===position.latitude,'Event does not move with driver');
  // Turn the two synthetic deliveries into a batch, next stop selects current order.
  await db.query("INSERT INTO routes(id,tenant_id,store_id,courier_profile_id,status,label) VALUES($1,$2,$3,$4,'ACTIVE','Synthetic batch')",[batch,tenant,store,driverId]);
  await db.query('UPDATE deliveries SET route_id=$1,courier_profile_id=$2 WHERE id=ANY($3::uuid[])',[batch,driverId,[delivery,secondDelivery]]);
  await db.query("INSERT INTO route_stops(tenant_id,route_id,delivery_id,stop_type,sequence) VALUES($1,$2,$3,'DELIVERY',1),($1,$2,$4,'DELIVERY',2)",[tenant,batch,delivery,secondDelivery]);
  const mechanical=await call('POST','/driver-events',{eventType:'MECHANICAL_PROBLEM',batchId:batch},driver);
  assert.equal(mechanical.status,201,JSON.stringify(mechanical.body));checks++;
  check(mechanical.body.batchId===batch&&mechanical.body.scope==='BATCH'&&mechanical.body.currentDeliveryId===delivery,'Mechanical event scoped to batch');
  const customer=await call('POST','/driver-events',{eventType:'CUSTOMER_NOT_RESPONDING',batchId:batch},driver);
  check(customer.body.scope==='DELIVERY'&&customer.body.deliveryId===delivery,'Customer event scoped to current delivery');
  const secondHistory=await call('GET',`/driver-events?deliveryId=${secondDelivery}`,undefined,manager);
  check(secondHistory.body.data.length===1&&secondHistory.body.data[0].id===mechanical.body.id,'Batch counts reach all affected orders, specific event only one');
  check((await call('POST','/driver-events',{eventType:'ADDRESS_PROBLEM',deliveryId:secondDelivery},driver)).status===409,'Forged non-current batch order rejected');
  await db.query('UPDATE deliveries SET courier_profile_id=$1,route_id=NULL WHERE id=$2',[otherDriverId,secondDelivery]);
  check((await call('GET',`/driver-events?deliveryId=${secondDelivery}`,undefined,manager)).body.data.length===1,'Reassignment preserves first driver history');
  check((await call('GET',`/driver-events?deliveryId=${secondDelivery}`,undefined,otherDriver)).body.data.length===0,'Replacement does not receive original internal event');
  check((await call('PATCH',`/driver-events/${mechanical.body.id}/resolve`,{},driver)).status===200,'Original driver can resolve own event after reassignment');
  const critical=await call('POST','/driver-events',{eventType:'ACCIDENT',batchId:batch},driver);
  check(critical.body.severity==='CRITICAL','Critical policy assigned on backend');
  check((await db.query("SELECT 1 FROM outbox_events WHERE aggregate_id=$1 AND event_type='driver-event.created' AND payload->>'severity'='CRITICAL'",[critical.body.id])).rowCount===1,'Critical notification queued transactionally');
  check((await call('PATCH',`/driver-events/${critical.body.id}/cancel`,{},driver)).status===403,'Driver cannot cancel history');
  check((await call('PATCH',`/driver-events/${critical.body.id}/cancel`,{},manager)).body.status==='CANCELLED','Authorized operation can cancel without deletion');
  await db.query("UPDATE courier_last_locations SET captured_at=now()-interval '10 minutes' WHERE courier_profile_id=$1",[driverId]);
  const noLocation=await call('POST','/driver-events',{eventType:'HEAVY_TRAFFIC',batchId:batch},driver);
  check(noLocation.body.latitude===null&&noLocation.body.locationCapturedAt===null,'No stale coordinates fabricated');
  const punctuation=await call('POST','/driver-events',{eventType:'OTHER',description:'Aguardando — assistência “local”',batchId:batch},driver);
  check(punctuation.status===201&&punctuation.body.description==='Aguardando - assistência "local"','Mobile punctuation normalized without losing observation');
  const encoding=(await db.query("SELECT current_setting('server_encoding') AS encoding")).rows[0].encoding;
  if(encoding==='LATIN1')check((await call('POST','/driver-events',{eventType:'OTHER',description:'Parada temporária 😅',batchId:batch},driver)).status===400,'Unsupported legacy encoding returns validation, not 500');
  check(leaked===0,'No Socket leaks to other store/courier');
  check((await db.query("SELECT count(*)::int AS count FROM audit_logs WHERE tenant_id=$1 AND entity_type='driver_operational_event'",[tenant])).rows[0].count>=10,'Audit records all changes');
  process.stdout.write(`OK: ${checks} driver operational event checks (HTTP, PostgreSQL RLS and real Socket.io); ${ui?'temporary UI transaction remains open':'fixtures will be rolled back'}.\n`);
  if(ui){process.stdout.write(JSON.stringify({temporaryUi:true,driver:prefix+'-driver@example.test',manager:prefix+'-manager@example.test',password:uiPassword})+'\n');
    await new Promise<void>(resolve=>{process.once('SIGINT',()=>resolve());process.once('SIGTERM',()=>resolve());});}
} finally {
  sockets.forEach(socket=>socket.disconnect());await app?.close();await connection.query('ROLLBACK');connection.release();await pool.end();
}
