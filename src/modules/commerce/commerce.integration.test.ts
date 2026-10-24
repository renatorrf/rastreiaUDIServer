import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import type { Database } from '../../database/pool.js';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext, PlatformAuthContext } from '../auth/auth.types.js';
import { withIdempotency } from '../../shared/idempotency.js';
import { cancelSubscription, createPlanVersion, saveCategory, saveProduct, subscribeStore, subscriptionSelect } from './commerce.service.js';
import { planSchema, productSchema, subscriptionSchema } from './commerce.schemas.js';
import { adjustInventory, saveVariant, saveStorefront, variantSelect } from './inventory.service.js';
import { adjustmentSchema } from './inventory.schemas.js';
import { cartRoutes,cartTokenHash } from './cart.routes.js';
import { requestHash } from '../../shared/idempotency.js';
import { applyImport,previewImport,loadImport,importOptionsSchema,type ImportOptions } from './catalog-import.service.js';

describe('commerce catalog and live contracts with PGlite PostgreSQL RLS',()=>{
  const pg=new PGlite();
  const tenant=randomUUID(),otherTenant=randomUUID(),store=randomUUID(),otherStore=randomUUID(),sibling=randomUUID();
  const manager=randomUUID(),courier=randomUUID(),operator=randomUUID(),masterId=randomUUID();
  const auth:AuthContext={tenantId:tenant,userId:manager,role:'TENANT_MANAGER',storeIds:[store],sessionId:randomUUID()};
  const master:PlatformAuthContext={userId:masterId,role:'PLATFORM_ADMIN',sessionId:randomUUID()};
  const client={query:async(sql:string,values?:unknown[])=>{
    const result=await pg.query(sql,values);return {...result,rowCount:Math.max(result.affectedRows ?? 0,result.rows.length)};
  }} as unknown as PoolClient;
  const product={name:'Café especial',sku:'CAFE',description:'250 g',categoryId:null,priceCents:2500,costCents:1000,active:true};
  const plan={code:'LIVE4',name:'Live 4',monthlyPriceCents:149000,monthlyLiveLimit:4,maxDurationMinutes:120,
    maxConcurrentViewers:200,expectedVersion:0,reason:'Pacote de teste isolado'};
  async function context<T>(kind:'master'|'manager'|'courier'|'operator',run:()=>Promise<T>,commit=false) {
    await pg.exec('BEGIN;SET LOCAL ROLE rastreia_runtime');
    try {
      await pg.query("SELECT set_config('app.user_id',$1,true),set_config('app.tenant_id',$2,true),set_config('app.platform_admin_id',$3,true)",
        [kind==='master'?'':kind==='courier'?courier:kind==='operator'?operator:manager,kind==='master'?'':tenant,kind==='master'?masterId:'']);
      const result=await run();await pg.exec(commit?'COMMIT':'ROLLBACK');return result;
    }catch(error){await pg.exec('ROLLBACK');throw error;}
  }
  beforeAll(async()=>{
    await pg.exec(`CREATE SCHEMA rastreia;SET search_path=rastreia,public;CREATE ROLE rastreia_runtime;
      GRANT USAGE ON SCHEMA rastreia TO rastreia_runtime;
      CREATE FUNCTION current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('app.user_id',true),'')::uuid$$;
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('app.tenant_id',true),'')::uuid$$;
      CREATE TABLE platform_admins(id uuid PRIMARY KEY);
      CREATE FUNCTION is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM platform_admins WHERE id=nullif(current_setting('app.platform_admin_id',true),'')::uuid)$$;
      CREATE TABLE tenants(id uuid PRIMARY KEY,status text DEFAULT 'ACTIVE');
      CREATE TABLE companies(id uuid PRIMARY KEY,tenant_id uuid,status text DEFAULT 'ACTIVE');
      CREATE TABLE stores(id uuid PRIMARY KEY,tenant_id uuid,company_id uuid,status text DEFAULT 'ACTIVE',UNIQUE(id,tenant_id));
      CREATE TABLE users(id uuid PRIMARY KEY,name text DEFAULT 'Gestor teste',status text DEFAULT 'ACTIVE');
      CREATE TABLE tenant_users(tenant_id uuid,user_id uuid,role text,status text DEFAULT 'ACTIVE');
      CREATE TABLE store_access(user_id uuid,store_id uuid);
      CREATE FUNCTION has_store_access(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM store_access WHERE user_id=$1 AND store_id=$2)$$;
      CREATE TABLE audit_logs(tenant_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,ip inet);
      CREATE TABLE platform_audit_logs(actor_platform_admin_id uuid,action text,entity_type text,entity_id uuid,target_tenant_id uuid,before_data jsonb,after_data jsonb,reason text);
      CREATE TABLE idempotency_keys(tenant_id uuid,idempotency_key text,operation text,actor_user_id uuid,request_hash text,response_status integer,response_body jsonb,UNIQUE(tenant_id,idempotency_key,operation));
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA rastreia TO rastreia_runtime;`);
    await pg.exec('BEGIN;'+await readFile(new URL('../../../migrations/0053_commerce_catalog_live_plans.sql',import.meta.url),'utf8')+'COMMIT');
    await pg.exec('BEGIN;'+await readFile(new URL('../../../migrations/0054_commerce_inventory_storefront.sql',import.meta.url),'utf8')+'COMMIT');
    await pg.exec('BEGIN;'+await readFile(new URL('../../../migrations/0055_commerce_media_imports.sql',import.meta.url),'utf8')+'COMMIT');
    await pg.exec('BEGIN;'+await readFile(new URL('../../../migrations/0056_commerce_guest_carts.sql',import.meta.url),'utf8')+'COMMIT');
    await pg.exec('BEGIN;'+await readFile(new URL('../../../migrations/0057_commerce_production_products.sql',import.meta.url),'utf8')+'COMMIT');
    await pg.query('INSERT INTO platform_admins VALUES($1)',[masterId]);
    await pg.query('INSERT INTO tenants(id) VALUES($1),($2)',[tenant,otherTenant]);
    const company=randomUUID();await pg.query('INSERT INTO companies(id,tenant_id) VALUES($1,$2)',[company,tenant]);
    await pg.query('INSERT INTO stores(id,tenant_id,company_id) VALUES($1,$4,$6),($2,$5,$6),($3,$4,$6)',[store,otherStore,sibling,tenant,otherTenant,company]);
    await pg.query('INSERT INTO users(id) VALUES($1),($2),($3)',[manager,courier,operator]);
    await pg.query("INSERT INTO tenant_users(tenant_id,user_id,role) VALUES($1,$2,'TENANT_MANAGER'),($1,$3,'COURIER'),($1,$4,'STORE_OPERATOR')",[tenant,manager,courier,operator]);
    await pg.query('INSERT INTO store_access VALUES($1,$4),($2,$4),($3,$4)',[manager,courier,operator,store]);
  },30000);
  afterAll(()=>pg.close());
  type TestCart={id:string;version:number;totalQuantity:number;subtotalCents:number;expired:boolean;storeAvailable:boolean;items:{variantId:string;quantity:number;maxQuantity:number;status:string;unitPriceCents:number;priceChanged:boolean;productName:string}[]};
  const ownerHash=cartTokenHash('a'.repeat(43)),otherHash=cartTokenHash('b'.repeat(43));
  const readCart=async(id:string,hash=ownerHash)=>(await pg.query<{data:TestCart|null}>('SELECT commerce_cart_read($1,$2) AS data',[id,hash])).rows[0]!.data;
  async function cartFixture(){
    const v=await stockFixture();await adjustInventory(client,auth,store,{variantId:v.id,expectedVersion:1,delta:10,kind:'ENTRY',reason:'Saldo do catálogo'});
    await saveStorefront(client,auth,store,{slug:'loja-carrinho',title:'Loja carrinho',description:'',published:true,expectedVersion:0});
    await pg.query('UPDATE commerce_products SET published=true WHERE id=$1',[v.productId]);
    const id=(await pg.query<{id:string}>("SELECT commerce_cart_open('loja-carrinho',$1) AS id",[ownerHash])).rows[0]!.id;return {id,v};
  }
  async function setCart(id:string,variant:string|null,quantity:number|null,version:number,key=randomUUID(),refresh=false,hash=ownerHash){
    return (await pg.query<{data:TestCart}>('SELECT commerce_cart_change($1,$2,$3,$4,$5,$6,$7,$8) AS data',[id,hash,variant,quantity,version,key,requestHash({variant,quantity,version,refresh}),refresh])).rows[0]!.data;
  }
  it('keeps a guest cart on the server and replays additions without doubling or reserving stock',()=>context('manager',async()=>{
    const {id,v}=await cartFixture(),key=randomUUID();const first=await setCart(id,v.id,2,1,key);
    expect(first.totalQuantity).toBe(2);expect(first.subtotalCents).toBe(v.priceCents*2);expect(first.version).toBe(2);
    expect(await setCart(id,v.id,2,1,key)).toEqual(first);expect((await readCart(id))?.items).toHaveLength(1);
    const opened=(await pg.query<{id:string}>("SELECT commerce_cart_open('loja-carrinho',$1) AS id",[ownerHash])).rows[0]!.id;expect(opened).toBe(id);
    expect((await pg.query<{reserved:number;on_hand:number}>('SELECT reserved,on_hand FROM commerce_inventory_balances WHERE variant_id=$1',[v.id])).rows[0]).toEqual({reserved:0,on_hand:10});
    const publicData=JSON.stringify(first);for(const field of ['costCents','cost_cents','tenant_id','token_hash','sku'])expect(publicData).not.toContain(field);
  }));
  const publicProducts=async()=> (await pg.query<{data:{total:number;data:{stockMode:string;variants:{available:boolean}[]}[]}}>(
    "SELECT commerce_public_products('loja-carrinho','',NULL,20,0) AS data")).rows[0]!.data;
  it('keeps zero-stock products visible but allows production items in the cart without physical balance',()=>context('manager',async()=>{
    const {id,v}=await cartFixture();
    await adjustInventory(client,auth,store,{variantId:v.id,expectedVersion:2,delta:-10,kind:'EXIT',reason:'Esvaziar saldo de teste'});
    const stocked=await publicProducts();expect(stocked.total).toBe(1);expect(stocked.data[0]!.variants[0]!.available).toBe(false);
    const changed=await saveProduct(client,auth,store,{...product,stockMode:'MADE_TO_ORDER'},v.productId,1);
    expect(changed?.stockMode).toBe('MADE_TO_ORDER');
    const made=await publicProducts();expect(made.data[0]!.stockMode).toBe('MADE_TO_ORDER');expect(made.data[0]!.variants[0]!.available).toBe(true);
    const cart=await setCart(id,v.id,99,1);expect(cart.items[0]).toMatchObject({status:'AVAILABLE',maxQuantity:99});
    expect(cart.subtotalCents).toBe(v.priceCents*99);
    expect((await pg.query('SELECT on_hand,reserved FROM commerce_inventory_balances WHERE variant_id=$1',[v.id])).rows[0]).toEqual({on_hand:0,reserved:0});
    // A legacy client or an import omitting stockMode must preserve the manager choice.
    const preserved=await saveProduct(client,auth,store,product,v.productId,2);expect(preserved?.stockMode).toBe('MADE_TO_ORDER');
    await saveProduct(client,auth,store,{...product,stockMode:'STOCKED'},v.productId,3);
    expect((await readCart(id))!.items[0]).toMatchObject({status:'INSUFFICIENT_STOCK',maxQuantity:0});
    await expect(setCart(id,v.id,1,2)).rejects.toMatchObject({code:'23514'});
  }));
  it.each(['product','variant','category','store'])('still hides production items when %s is disabled',kind=>context('manager',async()=>{
    const {id,v}=await cartFixture();
    await saveProduct(client,auth,store,{...product,stockMode:'MADE_TO_ORDER'},v.productId,1);
    await setCart(id,v.id,1,1);
    if(kind==='product')await pg.query('UPDATE commerce_products SET published=false WHERE id=$1',[v.productId]);
    if(kind==='variant')await pg.query('UPDATE commerce_variants SET active=false WHERE id=$1',[v.id]);
    if(kind==='store')await pg.query('UPDATE commerce_storefronts SET published=false WHERE store_id=$1',[store]);
    if(kind==='category'){
      const category=await saveCategory(client,auth,store,{name:'Categoria arquivada',active:false});
      await pg.query('UPDATE commerce_products SET category_id=$2 WHERE id=$1',[v.productId,category.id]);
    }
    expect((await publicProducts()).total).toBe(0);expect((await readCart(id))!.items[0]!.status).toBe('UNAVAILABLE');
    await expect(setCart(id,v.id,2,2)).rejects.toMatchObject({code:'P0001'});
  }));
  it('accepts only known availability modes and defaults old product creations to stock',()=>context('manager',async()=>{
    expect(productSchema.safeParse({...product,stockMode:'UNLIMITED'}).success).toBe(false);
    expect((await saveProduct(client,auth,store,product))?.stockMode).toBe('STOCKED');
  }));
  it('does not reveal carts by guessed ID or allow a token from another guest',()=>context('manager',async()=>{
    const {id,v}=await cartFixture();await setCart(id,v.id,1,1);expect(await readCart(id,otherHash)).toBeNull();
    await expect(setCart(id,v.id,2,2,randomUUID(),false,otherHash)).rejects.toMatchObject({code:'P0002'});
  }));
  it('rejects stale changes instead of overwriting another tab',()=>context('manager',async()=>{
    const {id,v}=await cartFixture();await setCart(id,v.id,2,1);await expect(setCart(id,v.id,3,1)).rejects.toMatchObject({code:'40001'});
  }));
  it('rejects reuse of a mutation key with another quantity',()=>context('manager',async()=>{
    const {id,v}=await cartFixture(),key=randomUUID();await setCart(id,v.id,2,1,key);await expect(setCart(id,v.id,3,1,key)).rejects.toMatchObject({code:'23505'});
  }));
  it('recalculates current prices and retains items after stock falls or publication is removed',()=>context('manager',async()=>{
    const {id,v}=await cartFixture();await setCart(id,v.id,2,1);
    await pg.query('UPDATE commerce_variants SET price_cents=3100 WHERE id=$1',[v.id]);
    const repriced=(await readCart(id))!;expect(repriced.subtotalCents).toBe(6200);expect(repriced.items[0]!.priceChanged).toBe(true);
    await adjustInventory(client,auth,store,{variantId:v.id,expectedVersion:2,delta:-9,kind:'LOSS',reason:'Avaria no estoque'});
    expect((await readCart(id))!.items[0]!.status).toBe('INSUFFICIENT_STOCK');
    await pg.query('UPDATE commerce_products SET published=false WHERE id=$1',[v.productId]);
    const unavailable=(await readCart(id))!;expect(unavailable.items).toHaveLength(1);expect(unavailable.items[0]!.status).toBe('UNAVAILABLE');
    expect((await setCart(id,v.id,0,2)).items).toEqual([]);
  }));
  it('supports explicit review without discarding lines after 30 days',()=>context('manager',async()=>{
    const {id,v}=await cartFixture();await setCart(id,v.id,2,1);await pg.exec('RESET ROLE');await pg.query("UPDATE commerce_guest_carts SET expires_at=now()-interval '1 day' WHERE id=$1",[id]);await pg.exec('SET LOCAL ROLE rastreia_runtime');
    expect((await readCart(id))?.expired).toBe(true);const renewed=await setCart(id,null,null,2,randomUUID(),true);expect(renewed.expired).toBe(false);expect(renewed.items[0]!.quantity).toBe(2);
  }));
  it('rejects unavailable quantities and variants belonging to another store',()=>context('manager',async()=>{
    const {id,v}=await cartFixture();await expect(setCart(id,v.id,11,1)).rejects.toMatchObject({code:'23514'});
  }));
  it('requires public product eligibility even when an internal variant ID is known',()=>context('manager',async()=>{
    const {id,v}=await cartFixture();await pg.query('UPDATE commerce_products SET published=false WHERE id=$1',[v.productId]);await expect(setCart(id,v.id,1,1)).rejects.toMatchObject({code:'P0001'});
  }));
  it('separates carts and variants by store even for the same guest device',()=>context('manager',async()=>{
    const {id,v}=await cartFixture();await pg.exec('RESET ROLE');
    await pg.query("INSERT INTO commerce_storefronts(tenant_id,store_id,slug,title,published) VALUES($1,$2,'loja-irma','Loja irmã',true)",[tenant,sibling]);
    const otherProduct=(await pg.query<{id:string}>("INSERT INTO commerce_products(tenant_id,store_id,name,sku,price_cents,cost_cents,active,published) VALUES($1,$2,'Outro produto','OUTRO',2000,1000,true,true) RETURNING id",[tenant,sibling])).rows[0]!.id;
    const otherVariant=(await pg.query<{id:string}>('SELECT id FROM commerce_variants WHERE product_id=$1',[otherProduct])).rows[0]!.id;
    await pg.query('UPDATE commerce_inventory_balances SET on_hand=10 WHERE variant_id=$1',[otherVariant]);await pg.exec('SET LOCAL ROLE rastreia_runtime');
    const otherCart=(await pg.query<{id:string}>("SELECT commerce_cart_open('loja-irma',$1) AS id",[otherHash])).rows[0]!.id;
    expect(otherCart).not.toBe(id);await setCart(id,v.id,1,1);expect((await readCart(otherCart,otherHash))?.items).toEqual([]);
    await expect(setCart(id,otherVariant,1,2)).rejects.toMatchObject({code:'P0001'});
  }));
  it('keeps carts recoverable when the storefront is hidden',()=>context('manager',async()=>{
    const {id,v}=await cartFixture();await setCart(id,v.id,1,1);await pg.query('UPDATE commerce_storefronts SET published=false WHERE store_id=$1',[store]);
    const hidden=(await readCart(id))!;expect(hidden.storeAvailable).toBe(false);expect(hidden.items).toHaveLength(1);expect(hidden.items[0]!.status).toBe('UNAVAILABLE');
  }));
  it('denies direct runtime reads of guest credentials and all cart tables',()=>context('manager',async()=>{
    await expect(pg.query('SELECT * FROM commerce_guest_carts')).rejects.toMatchObject({code:'42501'});
  }));
  const importOptions:ImportOptions=importOptionsSchema.parse({mapping:{sku:0,name:1,price:2,stock:3,category:4},matchKey:'sku',mode:'upsert'});
  async function importFixture(rows=[['NOVO','Produto novo','29,90','10','Bebidas']]){
    return (await pg.query<{id:string}>(`INSERT INTO commerce_import_jobs(tenant_id,store_id,file_name,file_hash,source,created_by) VALUES($1,$2,'catalogo.csv',$3,$4,$5) RETURNING id`,[tenant,store,randomUUID(),JSON.stringify({columns:['SKU','Nome','Preço','Estoque','Categoria'],rows}),manager])).rows[0]!.id;
  }
  it('previews without changing products and atomically imports stock, categories and drafts once',()=>context('manager',async()=>{
    const id=await importFixture(),preview=await previewImport(client,store,id,importOptions);
    expect((await pg.query('SELECT id FROM commerce_products')).rows).toHaveLength(0);expect(preview.preview?.[0]?.action).toBe('INSERT');
    const applied=await applyImport(client,auth,store,id,preview.previewToken!,'Carga inicial conferida');expect(applied.result).toEqual({inserted:1,updated:0,ignored:0,errors:0});
    const replay=await applyImport(client,auth,store,id,preview.previewToken!,'Repetição após timeout');expect(replay.result).toEqual(applied.result);
    expect((await pg.query<{published:boolean}>('SELECT published FROM commerce_products')).rows).toEqual([{published:false}]);
    expect((await pg.query<{on_hand:number}>('SELECT on_hand FROM commerce_inventory_balances')).rows).toEqual([{on_hand:10}]);
    expect((await pg.query('SELECT id FROM commerce_inventory_movements')).rows).toHaveLength(1);
    expect((await pg.query('SELECT id FROM commerce_categories')).rows).toHaveLength(1);
  }));
  it('rejects invalid rows until explicitly ignored, without partial catalog writes',()=>context('manager',async()=>{
    const id=await importFixture([['SKU1','Bom produto','10,00','4','Grupo'],['SKU2','Ruim','-1','4','Grupo']]);
    const preview=await previewImport(client,store,id,importOptions);expect(preview.preview?.map(r=>r.action)).toEqual(['INSERT','ERROR']);
    await expect(applyImport(client,auth,store,id,preview.previewToken!,'Conferência teste')).rejects.toMatchObject({statusCode:409});
    expect((await pg.query('SELECT id FROM commerce_products')).rows).toHaveLength(0);
    const corrected=await previewImport(client,store,id,{...importOptions,skipRows:[3]});
    const result=await applyImport(client,auth,store,id,corrected.previewToken!,'Ignorar linha inválida');expect(result.result?.inserted).toBe(1);expect(result.result?.ignored).toBe(1);
  }));
  it('requires a fresh preview after concurrent product or inventory changes',()=>context('manager',async()=>{
    const p=await saveProduct(client,auth,store,{...product,sku:'NOVO'}),id=await importFixture(),preview=await previewImport(client,store,id,importOptions);
    await saveProduct(client,auth,store,{...product,sku:'NOVO',priceCents:5000},String(p!.id),1);
    await expect(applyImport(client,auth,store,id,preview.previewToken!,'Carga conferida')).rejects.toMatchObject({statusCode:409});
    const next=await previewImport(client,store,id,importOptions);const variant=(await pg.query<{id:string}>('SELECT id FROM commerce_variants WHERE product_id=$1',[p!.id])).rows[0]!;
    await adjustInventory(client,auth,store,{variantId:variant.id,expectedVersion:1,delta:2,kind:'ENTRY',reason:'Entrada concorrente'});
    await expect(applyImport(client,auth,store,id,next.previewToken!,'Carga conferida')).rejects.toMatchObject({statusCode:409});
  }));
  it('matches barcodes, preserves unmapped fields and reports duplicate codes',()=>context('manager',async()=>{
    const p=await saveProduct(client,auth,store,{...product,barcode:'0001234567890'});
    const id=await importFixture([['NOVO','Nome atualizado','19,99','0001234567890',''],['DUP','Duplicado','20','0001234567890','']]);
    const options={...importOptions,mapping:{sku:0,name:1,price:2,barcode:3},matchKey:'barcode' as const};
    const preview=await previewImport(client,store,id,options);expect(preview.preview?.[0]?.productId).toBe(p!.id);expect(preview.preview?.[0]?.input?.costCents).toBe(1000);expect(preview.preview?.[1]?.action).toBe('ERROR');
    const fixed=await previewImport(client,store,id,{...options,skipRows:[3]});await applyImport(client,auth,store,id,fixed.previewToken!,'Revisão por código');
    expect((await pg.query<{sku:string;barcode:string}>('SELECT sku,barcode FROM commerce_products')).rows).toEqual([{sku:'NOVO',barcode:'0001234567890'}]);
  }));
  it('limits imports to the authorized unit and prevents hash duplication',()=>context('manager',async()=>{
    const id=await importFixture();await expect(loadImport(client,sibling,id)).rejects.toMatchObject({statusCode:404});await expect(loadImport(client,otherStore,id)).rejects.toMatchObject({statusCode:404});
    await expect(pg.query(`INSERT INTO commerce_import_jobs(tenant_id,store_id,file_name,file_hash,source,created_by) SELECT tenant_id,store_id,file_name,file_hash,source,created_by FROM commerce_import_jobs WHERE id=$1`,[id])).rejects.toMatchObject({code:'23505'});
  }));
  it('supports insert-only and update-only modes without silently creating skipped products',()=>context('manager',async()=>{
    await saveProduct(client,auth,store,{...product,sku:'NOVO'});const id=await importFixture([['NOVO','Existente','12,00','4','Bebidas'],['OUTRO','Novo produto','13,00','2','Bebidas']]);
    const insert=await previewImport(client,store,id,{...importOptions,mode:'insert'});expect(insert.preview?.map(r=>r.action)).toEqual(['IGNORE','INSERT']);
    const update=await previewImport(client,store,id,{...importOptions,mode:'update'});expect(update.preview?.map(r=>r.action)).toEqual(['UPDATE','IGNORE']);
    await applyImport(client,auth,store,id,update.previewToken!,'Atualização conferida');expect((await pg.query('SELECT id FROM commerce_products')).rows).toHaveLength(1);
  }));
  it('rejects expired and superseded previews and reused mapped columns',()=>context('manager',async()=>{
    const id=await importFixture(),first=await previewImport(client,store,id,importOptions);
    const second=await previewImport(client,store,id,importOptions);await expect(applyImport(client,auth,store,id,first.previewToken!,'Teste de versão')).rejects.toMatchObject({statusCode:409});
    await pg.query("UPDATE commerce_import_jobs SET preview_expires_at=now()-interval '1 minute' WHERE id=$1",[id]);
    await expect(applyImport(client,auth,store,id,second.previewToken!,'Teste de expiração')).rejects.toMatchObject({statusCode:409});
    await expect(previewImport(client,store,id,{...importOptions,mapping:{sku:0,name:0,price:2}})).rejects.toMatchObject({statusCode:409});
  }));
  it('rolls back the whole batch if persistence fails after the first product',async()=>{
    await expect(context('manager',async()=>{
      const id=await importFixture([['ATOMIC1','Produto um','10','2','Grupo'],['ATOMIC2','Produto dois','10','2','Grupo']]),preview=await previewImport(client,store,id,importOptions);
      let inserts=0;const failing={query:async(sql:string,values?:unknown[])=>{if(sql.includes('INSERT INTO commerce_products(')&&++inserts===2)throw new Error('Simulated DB failure');return client.query(sql,values);}} as unknown as PoolClient;
      await applyImport(failing,auth,store,id,preview.previewToken!,'Teste atômico');
    })).rejects.toThrow('Simulated DB failure');
    expect((await pg.query("SELECT id FROM commerce_products WHERE sku LIKE 'ATOMIC%'")).rows).toHaveLength(0);
  });
  it('denies courier access to imports and image metadata',()=>context('courier',async()=>{
    expect((await pg.query('SELECT * FROM commerce_import_jobs')).rows).toEqual([]);expect((await pg.query('SELECT * FROM commerce_product_images')).rows).toEqual([]);
    await expect(importFixture()).rejects.toMatchObject({code:'42501'});
  }));
  it('public images require published product/store and expose no storage keys in listings',()=>context('manager',async()=>{
    const p=await saveProduct(client,auth,store,product),id=randomUUID();
    await pg.query(`INSERT INTO commerce_product_images(id,tenant_id,store_id,product_id,object_key,thumbnail_key,checksum,alt,width,height,bytes,created_by) VALUES($1,$2,$3,$4,'private/full.webp','private/thumb.webp','hash','Foto teste',100,100,100,$5)`,[id,tenant,store,p!.id,manager]);
    await saveStorefront(client,auth,store,{slug:'loja-fotos',title:'Loja fotos',description:'',published:true,expectedVersion:0});
    const key=async()=>(await pg.query<{key:string|null}>("SELECT commerce_public_image('loja-fotos',$1,false) AS key",[id])).rows[0]!.key;
    expect(await key()).toBeNull();await pg.query('UPDATE commerce_products SET published=true WHERE id=$1',[p!.id]);expect(await key()).toBe('private/full.webp');
    const data=(await pg.query<{data:unknown}>("SELECT commerce_public_products('loja-fotos','',NULL,20,0) AS data")).rows[0]!.data;
    expect(JSON.stringify(data)).toContain('Foto teste');expect(JSON.stringify(data)).not.toContain('private/');
    await pg.query('UPDATE commerce_product_images SET archived=true WHERE id=$1',[id]);expect(await key()).toBeNull();
  }));
  it('creates and updates products without rounding prices',()=>context('manager',async()=>{
    const category=await saveCategory(client,auth,store,{name:'Bebidas',active:true});
    const created=await saveProduct(client,auth,store,{...product,categoryId:category.id as string});
    expect(created?.priceCents).toBe(2500);expect(created?.categoryName).toBe('Bebidas');
    const updated=await saveProduct(client,auth,store,{...product,priceCents:2599},created!.id as string,1);
    expect(updated?.version).toBe(2);expect(updated?.priceCents).toBe(2599);
    await expect(saveProduct(client,auth,store,product,created!.id as string,1)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  }));
  it('archives without deleting and prevents SKU duplicates',()=>context('manager',async()=>{
    const created=await saveProduct(client,auth,store,product);
    await saveProduct(client,auth,store,{...product,active:false},created!.id as string,1);
    expect((await pg.query<{active:boolean}>('SELECT active FROM commerce_products')).rows[0]!.active).toBe(false);
    await expect(saveProduct(client,auth,store,{...product,sku:'cafe'})).rejects.toMatchObject({code:'23505'});
  }));
  it('denies another tenant and another store in the same tenant',()=>context('manager',async()=>{
    await expect(saveProduct(client,auth,otherStore,product)).rejects.toMatchObject({statusCode:404});
    await expect(saveProduct(client,auth,sibling,product)).rejects.toMatchObject({statusCode:404});
  }));
  for(const role of ['courier','operator'] as const)it(`denies ${role} even with operational store access`,()=>context(role,async()=>{
    await expect(saveProduct(client,auth,store,product)).rejects.toMatchObject({statusCode:404});
    expect((await pg.query('SELECT * FROM commerce_products')).rows).toHaveLength(0);
  }));
  it('rejects forged tenant at the RLS boundary',()=>context('manager',async()=>{
    await expect(pg.query('INSERT INTO commerce_categories(tenant_id,store_id,name) VALUES($1,$2,$3)',[otherTenant,store,'Forjada'])).rejects.toMatchObject({code:'42501'});
  }));
  it('cannot associate a category from another store',async()=>{
    const category=randomUUID();await pg.query('INSERT INTO commerce_categories(id,tenant_id,store_id,name) VALUES($1,$2,$3,$4)',[category,tenant,sibling,'Outra']);
    await context('manager',async()=>{await expect(saveProduct(client,auth,store,{...product,categoryId:category})).rejects.toMatchObject({statusCode:409});});
  });
  it('replays an idempotent write without a second product',()=>context('manager',async()=>{
    const execute=async()=>({statusCode:200,body:await saveProduct(client,auth,store,product)});
    const first=await withIdempotency(client,auth,'same-key-123','catalog.create',product,execute);
    const replay=await withIdempotency(client,auth,'same-key-123','catalog.create',product,execute);
    expect(replay.body).toEqual(first.body);expect(replay.replayed).toBe(true);
    expect((await pg.query('SELECT id FROM commerce_products')).rows).toHaveLength(1);
    await expect(withIdempotency(client,auth,'same-key-123','catalog.create',{...product,priceCents:1},execute)).rejects.toMatchObject({statusCode:409});
  }));
  it('keeps subscribed prices immutable across plan versions and prevents overlaps',()=>context('master',async()=>{
    const first=await createPlanVersion(client,master,plan);
    const input={planVersionId:first!.id as string,startsAt:'2026-01-01T00:00:00Z',endsAt:'2099-01-01T00:00:00Z',reason:'Contratação para teste'};
    const subscribed=await subscribeStore(client,master,store,input);
    const next=await createPlanVersion(client,master,{...plan,expectedVersion:1,monthlyPriceCents:199000});
    expect(next?.version).toBe(2);
    expect((await pg.query<{monthly_price_cents:number}>('SELECT monthly_price_cents FROM live_plan_versions WHERE id=$1',[first!.id])).rows[0]!.monthly_price_cents).toBe(149000);
    await expect(subscribeStore(client,master,store,{...input,planVersionId:next!.id as string})).rejects.toMatchObject({statusCode:409});
    await cancelSubscription(client,master,subscribed!.id as string,1,'Cancelamento solicitado');
    await expect(subscribeStore(client,master,store,{...input,planVersionId:next!.id as string})).resolves.toMatchObject({monthlyPriceCents:199000});
  }));
  it('manager cannot grant a live subscription or create a global plan',()=>context('manager',async()=>{
    await expect(createPlanVersion(client,master,plan)).rejects.toMatchObject({code:'42501'});
  }));
  it('database denies changes to price fields of an existing version',()=>context('master',async()=>{
    const row=await createPlanVersion(client,master,plan);
    await expect(pg.query('UPDATE live_plan_versions SET monthly_price_cents=1 WHERE id=$1',[row!.id])).rejects.toMatchObject({code:'42501'});
  }));
  it('exposes only contracted terms for an authorized store, never sibling or other tenant contracts',async()=>{
    let planId='';
    await context('master',async()=>{
      const created=await createPlanVersion(client,master,{...plan,code:'SCOPE'});planId=created!.id as string;
      for(const unit of [store,sibling,otherStore])await subscribeStore(client,master,unit,{planVersionId:planId,startsAt:'2026-01-01T00:00:00Z',endsAt:'2099-01-01T00:00:00Z',reason:'Isolamento por unidade'});
    },true);
    await context('manager',async()=>{
      const visible=await client.query(subscriptionSelect);expect(visible.rows).toHaveLength(1);expect(visible.rows[0].storeId).toBe(store);
      expect((await pg.query('SELECT id FROM live_plan_versions')).rows).toHaveLength(1);
      await expect(pg.query(`INSERT INTO store_live_subscriptions(tenant_id,store_id,plan_version_id,starts_at,ends_at,reason,created_by)
        VALUES($1,$2,$3,'2100-01-01','2100-02-01','Auto contratação',$4)`,[tenant,store,planId,masterId])).rejects.toMatchObject({code:'42501'});
    });
    await context('courier',async()=>{expect((await client.query(subscriptionSelect)).rows).toHaveLength(0);expect((await pg.query('SELECT id FROM live_plan_versions')).rows).toHaveLength(0);});
  });
  it('validates integer money, confirmed limits, payload ownership and dates',()=>{
    expect(productSchema.safeParse({...product,priceCents:0.1}).success).toBe(false);
    expect(productSchema.safeParse({...product,tenantId:otherTenant}).success).toBe(false);
    expect(planSchema.safeParse({...plan,maxDurationMinutes:121}).success).toBe(false);
    expect(planSchema.safeParse({...plan,maxConcurrentViewers:201}).success).toBe(false);
    expect(subscriptionSchema.safeParse({planVersionId:randomUUID(),startsAt:'2026-11-02T00:00:00Z',endsAt:'2026-11-01T00:00:00Z',reason:'Teste válido'}).success).toBe(false);
  });
  async function stockFixture(){
    const created=await saveProduct(client,auth,store,product);
    return (await client.query<import('./inventory.service.js').VariantRow>(`${variantSelect} WHERE v.product_id=$1`,[created!.id])).rows[0]!;
  }
  it('creates a default variant and a zero balance without publishing',()=>context('manager',async()=>{
    const v=await stockFixture();expect(v.onHand).toBe(0);expect(v.reserved).toBe(0);expect(v.isDefault).toBe(true);
    expect((await pg.query<{published:boolean}>('SELECT published FROM commerce_products')).rows[0]!.published).toBe(false);
    await saveProduct(client,auth,store,{...product,priceCents:2999},v.productId,1);
    expect((await client.query(`${variantSelect} WHERE v.id=$1`,[v.id])).rows[0]!.priceCents).toBe(2999);
  }));
  it('creates independent variants and archives without discarding their stock',()=>context('manager',async()=>{
    const v=await stockFixture();const input={name:'Azul / M',sku:'CAM-A-M',attributes:{color:'Azul',size:'M'},priceCents:3500,costCents:1500,minimumStock:2,active:true};
    const created=await saveVariant(client,auth,store,v.productId,input);
    await adjustInventory(client,auth,store,{variantId:created!.id,expectedVersion:1,delta:5,kind:'ENTRY',reason:'Estoque inicial'});
    const archived=await saveVariant(client,auth,store,v.productId,{...input,active:false},created!.id,1);
    expect(archived!.onHand).toBe(5);expect(archived!.active).toBe(false);
    await expect(saveVariant(client,auth,sibling,v.productId,input)).rejects.toMatchObject({statusCode:404});
  }));
  it('keeps movements consistent and replays stock adjustment only once',()=>context('manager',async()=>{
    const v=await stockFixture();const input={variantId:v.id,expectedVersion:1,delta:7,kind:'ENTRY' as const,reason:'Recebimento de compra'};
    const run=async()=>({statusCode:200,body:await adjustInventory(client,auth,store,input)});
    const first=await withIdempotency(client,auth,'stock-adjustment-test','inventory',input,run);
    const replay=await withIdempotency(client,auth,'stock-adjustment-test','inventory',input,run);
    expect(replay.replayed).toBe(true);expect(replay.body).toEqual(first.body);
    const next=await adjustInventory(client,auth,store,{...input,expectedVersion:2,delta:-2,kind:'LOSS',reason:'Avaria no transporte'});
    expect(next.onHand).toBe(5);expect(next.stockVersion).toBe(3);
    const moves=(await pg.query<{delta:number}>('SELECT delta FROM commerce_inventory_movements')).rows;
    expect(moves.length).toBe(2);expect(moves.reduce((sum,m)=>sum+m.delta,0)).toBe(5);
  }));
  it('rejects stale stock updates',()=>context('manager',async()=>{
    const v=await stockFixture();const input={variantId:v.id,expectedVersion:1,delta:5,kind:'ENTRY' as const,reason:'Entrada inicial'};
    await adjustInventory(client,auth,store,input);
    await expect(adjustInventory(client,auth,store,input)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  }));
  it('rejects stock below reserved quantities',()=>context('manager',async()=>{
    const v=await stockFixture();await expect(adjustInventory(client,auth,store,{variantId:v.id,expectedVersion:1,delta:-1,kind:'EXIT',reason:'Saída sem saldo'})).rejects.toMatchObject({statusCode:409});
  }));
  it('cannot bypass immutable stock ledger with a direct balance update',()=>context('manager',async()=>{
    const v=await stockFixture();await expect(pg.query('UPDATE commerce_inventory_balances SET on_hand=100 WHERE variant_id=$1',[v.id])).rejects.toMatchObject({code:'42501'});
  }));
  it('cannot rewrite inventory movement history',()=>context('manager',async()=>{
    const v=await stockFixture();await adjustInventory(client,auth,store,{variantId:v.id,expectedVersion:1,delta:3,kind:'ENTRY',reason:'Estoque contado'});
    await expect(pg.query("UPDATE commerce_inventory_movements SET reason='Outra razão'")).rejects.toMatchObject({code:'42501'});
  }));
  it('denies adjustment by courier even through the database function',()=>context('courier',async()=>{
    await expect(pg.query("SELECT commerce_adjust_inventory($1,$2,1,1,'ENTRY','Tentativa inválida')",[randomUUID(),store])).rejects.toMatchObject({code:'42501'});
  }));
  it('publishes only explicit active items and removes them immediately on unpublish',()=>context('manager',async()=>{
    const v=await stockFixture();const settings={slug:'loja-de-teste',title:'Catálogo teste',description:'Descrição pública',published:false,expectedVersion:0};
    await saveStorefront(client,auth,store,settings);
    expect((await pg.query<{data:unknown}>('SELECT commerce_public_store($1) AS data',[settings.slug])).rows[0]!.data).toBeNull();
    await saveStorefront(client,auth,store,{...settings,published:true,expectedVersion:1});
    expect((await pg.query<{data:{total:number}}>("SELECT commerce_public_products($1,'',NULL,20,0) AS data",[settings.slug])).rows[0]!.data.total).toBe(0);
    await pg.query('UPDATE commerce_products SET published=true WHERE id=$1',[v.productId]);
    const visible=(await pg.query<{data:{data:Array<Record<string,unknown>>;total:number}}>("SELECT commerce_public_products($1,'',NULL,20,0) AS data",[settings.slug])).rows[0]!.data;
    expect(visible.total).toBe(1);const serialized=JSON.stringify(visible);
    for(const field of ['costCents','cost_cents','tenantId','storeId','onHand','reserved','sku','actor'])expect(serialized).not.toContain(field);
    await saveStorefront(client,auth,store,{...settings,published:false,expectedVersion:2});
    expect((await pg.query<{data:{total:number}}>("SELECT commerce_public_products($1,'',NULL,20,0) AS data",[settings.slug])).rows[0]!.data.total).toBe(0);
  }));
  it('allows anonymous projections without access to the private variant tables',()=>context('manager',async()=>{
    const v=await stockFixture();await saveStorefront(client,auth,store,{slug:'catalogo-publico',title:'Loja pública',description:'',published:true,expectedVersion:0});
    await pg.query('UPDATE commerce_products SET published=true WHERE id=$1',[v.productId]);
    await pg.query("SELECT set_config('app.user_id','',true),set_config('app.tenant_id','',true)");
    expect((await pg.query('SELECT * FROM commerce_variants')).rows).toHaveLength(0);
    expect((await pg.query<{data:{total:number}}>("SELECT commerce_public_products('catalogo-publico','',NULL,20,0) AS data")).rows[0]!.data.total).toBe(1);
  }));
  it('hides archived products, categories and variants and does not leak private attributes',()=>context('manager',async()=>{
    const category=await saveCategory(client,auth,store,{name:'Categoria pública',active:true});
    const p=await saveProduct(client,auth,store,{...product,categoryId:String(category.id)});
    await saveStorefront(client,auth,store,{slug:'catalogo-filtrado',title:'Loja filtrada',description:'',published:true,expectedVersion:0});
    await pg.query('UPDATE commerce_products SET published=true WHERE id=$1',[p!.id]);
    const read=async()=>(await pg.query<{data:{total:number;data:unknown[]}}>("SELECT commerce_public_products('catalogo-filtrado','',NULL,20,0) AS data")).rows[0]!.data;
    await pg.query(`UPDATE commerce_variants SET attributes='{"color":"Azul","internalNote":"Private test data"}'::jsonb WHERE product_id=$1`,[p!.id]);
    expect(JSON.stringify(await read())).not.toContain('Private test data');expect((await read()).total).toBe(1);
    await pg.query('UPDATE commerce_categories SET active=false WHERE id=$1',[category.id]);expect((await read()).total).toBe(0);
    await pg.query('UPDATE commerce_categories SET active=true WHERE id=$1',[category.id]);
    await pg.query('UPDATE commerce_products SET active=false WHERE id=$1',[p!.id]);expect((await read()).total).toBe(0);
    await pg.query('UPDATE commerce_products SET active=true WHERE id=$1',[p!.id]);
    await pg.query('UPDATE commerce_variants SET active=false WHERE product_id=$1',[p!.id]);expect((await read()).total).toBe(0);
    expect((await pg.query<{data:{categories:unknown[]}}>("SELECT commerce_public_store('catalogo-filtrado') AS data")).rows[0]!.data.categories).toEqual([]);
  }));
  it('blocks reserved inventory depletion even with a valid physical balance',()=>context('manager',async()=>{
    const v=await stockFixture();await adjustInventory(client,auth,store,{variantId:v.id,expectedVersion:1,delta:10,kind:'ENTRY',reason:'Contagem física'});
    // Fixture simulates a future reservation service; runtime itself cannot do this update.
    await pg.exec('RESET ROLE');await pg.query('UPDATE commerce_inventory_balances SET reserved=8 WHERE variant_id=$1',[v.id]);await pg.exec('SET LOCAL ROLE rastreia_runtime');
    await expect(adjustInventory(client,auth,store,{variantId:v.id,expectedVersion:2,delta:-3,kind:'EXIT',reason:'Saída de teste'})).rejects.toMatchObject({statusCode:409});
  }));
  it('removes the public catalog when its store is suspended',()=>context('manager',async()=>{
    await stockFixture();await saveStorefront(client,auth,store,{slug:'loja-suspensa',title:'Loja suspensa',description:'',published:true,expectedVersion:0});
    await pg.exec('RESET ROLE');await pg.query("UPDATE stores SET status='SUSPENDED' WHERE id=$1",[store]);await pg.exec('SET LOCAL ROLE rastreia_runtime');
    expect((await pg.query<{data:unknown}>("SELECT commerce_public_store('loja-suspensa') AS data")).rows[0]!.data).toBeNull();
  }));
  it('keeps storefront slugs stable and validates manual adjustments',()=>context('manager',async()=>{
    const settings={slug:'loja-estavel',title:'Loja teste',description:'',published:false,expectedVersion:0};await saveStorefront(client,auth,store,settings);
    await expect(saveStorefront(client,auth,store,{...settings,slug:'outro-link',expectedVersion:1})).rejects.toMatchObject({statusCode:409});
    const input={variantId:randomUUID(),expectedVersion:1,delta:1,kind:'ENTRY',reason:'Entrada teste',confirmationPassword:'senha-de-teste'};
    expect(adjustmentSchema.safeParse({...input,delta:0}).success).toBe(false);
    expect(adjustmentSchema.safeParse({...input,delta:-1}).success).toBe(false);
    expect(adjustmentSchema.safeParse({...input,delta:1.5}).success).toBe(false);
  }));
  it('runs create, add, retry, recovery and removal through HTTP with the real SQL cart functions',async()=>{
    const {v}=await context('manager',()=>cartFixture(),true);
    const app=Fastify();app.setErrorHandler((error,_req,reply)=>{const e=error as Error&{statusCode?:number};reply.code(error instanceof ZodError?422:e.statusCode??500).send({message:e.message});});
    const db={connect:async()=>({query:client.query.bind(client),release:()=>{}})} as unknown as Database;
    await cartRoutes(app,db);const headers={'x-commerce-cart-token':'c'.repeat(43),'idempotency-key':'http-cart-create'};
    try{
      const created=await app.inject({method:'POST',url:'/public/commerce/stores/loja-carrinho/carts',headers,payload:{}});expect(created.statusCode).toBe(200);
      const cartId=created.json().id as string,path=`/public/commerce/carts/${cartId}/items/${v.id}`;
      const request={method:'PUT' as const,url:path,headers:{...headers,'idempotency-key':'http-cart-first-add'},payload:{quantity:2,expectedVersion:1}};
      const first=await app.inject(request),retry=await app.inject(request);expect(first.statusCode).toBe(200);expect(retry.json()).toEqual(first.json());expect(first.json().subtotalCents).toBe(v.priceCents*2);
      const restored=await app.inject({url:`/public/commerce/carts/${cartId}`,headers});expect(restored.json().totalQuantity).toBe(2);
      expect((await app.inject({url:`/public/commerce/carts/${cartId}`,headers:{'x-commerce-cart-token':'d'.repeat(43)}})).statusCode).toBe(404);
      const removed=await app.inject({...request,headers:{...headers,'idempotency-key':'http-cart-remove'},payload:{quantity:0,expectedVersion:2}});expect(removed.statusCode).toBe(200);expect(removed.json().items).toEqual([]);
    }finally{await app.close();}
  });
});
