import { describe,it,expect,vi } from 'vitest';
import type { Database } from '../../database/pool.js';
import type { AppEnv } from '../../config/env.js';
import { encryptPayload } from '../../shared/encrypted-payload.js';
import { processPixOrder } from './pix.service.js';

function fixture(){
 const env={BTG_ENABLED:true,BTG_ENCRYPTION_SECRET:'test-btg-key-not-a-real-secret-12345',MESSAGE_PAYLOAD_SECRET:'test-company-key'} as AppEnv;
 const payment={order_id:'order-1',company_id:'company-a',status:'CREATED',expires_at:new Date(Date.now()+900000),created_at:new Date(),settings_version:null as number|null,tax_id:null as string|null,pix_key:null as string|null,provider_id:null as string|null,tx_id:null as string|null,location_id:null as string|null,paid_at:null as Date|null,amount:'5750',order_status:'WAITING_PAYMENT'};
 const tokens={companyId:'company-a',tenantId:'tenant-a',mode:'production',clientId:'client-a',access_token:'test-access',refresh_token:'test-refresh',token_type:'Bearer',expires_in:3600,scope:'openid empresas.btgpactual.com/pix-cash-in'};
 const company={tenant_id:'tenant-a',status:'ACTIVE',tax_id_encrypted:encryptPayload({taxId:'12345678000199'},env.MESSAGE_PAYLOAD_SECRET)};
 const config={enabled:true,version:3,public_config:{mode:'production',clientId:'client-a',pixKey:'pix-a'},secret_config_encrypted:encryptPayload({clientSecret:'test-client-secret'},env.BTG_ENCRYPTION_SECRET)};
 let settlements=0,creates=0;
 const query=vi.fn(async(sql:string,params:unknown[]=[])=>{
  if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
  if(sql.includes('SELECT p.*,o.subtotal'))return {rows:payment.paid_at?[]:[{...payment}]};
  if(sql.includes('SELECT tenant_id,tax_id_encrypted'))return {rows:[company]};
  if(sql.includes('to_regclass'))return {rows:[{available:true}]};
  if(sql.includes('SELECT enabled,public_config'))return {rows:[config]};
  if(sql.includes('SELECT tokens_encrypted'))return {rows:[{tokens_encrypted:encryptPayload(tokens,env.BTG_ENCRYPTION_SECRET),expires_at:new Date(Date.now()+3600000),settings_version:3}]};
  if(sql.includes("status='REQUESTED'")){payment.status='REQUESTED';payment.settings_version=params[1] as number;payment.tax_id=params[2] as string;payment.pix_key=params[3] as string;creates++;}
  if(sql.includes("status=CASE WHEN expires_at>now()")){payment.status='PENDING';payment.provider_id=params[1] as string;payment.tx_id=params[2] as string;payment.location_id=params[3] as string;}
  if(sql.includes("status='REVIEW_REQUIRED'"))payment.status='REVIEW_REQUIRED';
  if(sql.includes('SELECT rastreia.commerce_pix_settle')){settlements++;payment.paid_at=new Date();payment.status='PAID';}
  return {rows:[]};
 });
 const release=vi.fn();const db={connect:async()=>({query,release}),query} as unknown as Database;
 return {db,env,payment,tokens,company,config,query,release,counts:()=>({creates,settlements})};
}
const charge={id:'charge-1',txId:'tx-1',taxId:'12345678000199',status:'ACTIVE',pixKey:'pix-a',amount:{value:57.5,allowCustomerChangeValue:false},location:{id:'location-1'},emv:'000201-test-pix-code-not-real',displayText:'Rastreia order-1'};
describe('Pix worker orchestration with isolated persistence and bank doubles',()=>{
 it('commits REQUESTED before POST and never posts twice after lost response',async()=>{
  const f=fixture();const fetcher=vi.fn<typeof fetch>().mockImplementation(async(_url,options)=>{if(options?.method==='POST'){expect(f.payment.status).toBe('REQUESTED');throw new Error('lost bank response');}return new Response(JSON.stringify({data:[]}));});
  await processPixOrder(f.db,f.env,'order-1',fetcher);expect(f.payment.status).toBe('REVIEW_REQUIRED');
  await processPixOrder(f.db,f.env,'order-1',fetcher);expect(fetcher.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1);expect(f.counts().creates).toBe(1);
 });
 it('creates, reconciles paid amount and ignores replay without duplicate settlement',async()=>{
  const f=fixture();const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({data:[]}))).mockResolvedValueOnce(new Response(JSON.stringify(charge)));
  await processPixOrder(f.db,f.env,'order-1',fetcher);expect(f.payment.status).toBe('PENDING');
  fetcher.mockResolvedValue(new Response(JSON.stringify({data:[{...charge,status:'PAID',paymentInfo:{endToEndId:'E123456789000',paymentDate:new Date().toISOString(),paidAmount:57.5}}]})));
  await processPixOrder(f.db,f.env,'order-1',fetcher);await processPixOrder(f.db,f.env,'order-1',fetcher);expect(f.counts()).toEqual({creates:1,settlements:1});
  expect(f.query).toHaveBeenCalledWith('SELECT rastreia.commerce_pix_settle($1,$2,$3,$4)',['order-1',5750,'E123456789000',expect.any(String)]);
 });
 it('fails closed on a token belonging to another company',async()=>{const f=fixture();f.tokens.companyId='company-b';const fetcher=vi.fn<typeof fetch>();await expect(processPixOrder(f.db,f.env,'order-1',fetcher)).rejects.toMatchObject({code:'PIX_CONFIGURATION_REQUIRED'});expect(fetcher).not.toHaveBeenCalled();});
 it('never releases real orders using sandbox credentials',async()=>{const f=fixture();f.config.public_config.mode='sandbox';const fetcher=vi.fn<typeof fetch>();await expect(processPixOrder(f.db,f.env,'order-1',fetcher)).rejects.toMatchObject({code:'PIX_CONFIGURATION_REQUIRED'});expect(fetcher).not.toHaveBeenCalled();});
 it('does not create a charge when less than 30 seconds of reservation remain',async()=>{const f=fixture();f.payment.expires_at=new Date(Date.now()+20000);const fetcher=vi.fn<typeof fetch>();await processPixOrder(f.db,f.env,'order-1',fetcher);expect(fetcher).not.toHaveBeenCalled();expect(f.counts().creates).toBe(0);});
 it('does not settle another charge returned by the bank',async()=>{const f=fixture();Object.assign(f.payment,{status:'PENDING',tax_id:'12345678000199',pix_key:'pix-a',provider_id:'charge-1',location_id:'location-1',tx_id:'tx-1'});const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({data:[{...charge,taxId:'11111111000111',status:'PAID',paymentInfo:{endToEndId:'E123456789000',paymentDate:new Date().toISOString(),paidAmount:57.5}}]})));await expect(processPixOrder(f.db,f.env,'order-1',fetcher)).rejects.toThrow('BTG_CHARGE_MISMATCH');expect(f.counts().settlements).toBe(0);});
});
