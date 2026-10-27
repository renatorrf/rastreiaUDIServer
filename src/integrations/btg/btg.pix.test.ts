import { describe,it,expect,vi } from 'vitest';
import { BtgPixClient,bankCents,assertCharge,type BankCharge } from './btg.pix.js';
const taxId='12345678000199';
const charge:BankCharge={id:'charge-1',txId:'tx-1',taxId,status:'ACTIVE',pixKey:'pix-key',amount:{value:57.50,allowCustomerChangeValue:false},location:{id:'location-1'},emv:'000201test-pix-copia-cola-only-fixture'};
describe('BTG Pix contract and confirmation boundaries',()=>{
 it('uses fixed production host, CNPJ scope, decimal reais and remaining expiration',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(charge)));
  await new BtgPixClient('private-token',taxId,fetcher).create({orderId:'order-1',pixKey:'pix-key',amountCents:5750,expiresIn:890});
  const [url,options]=fetcher.mock.calls[0]!;expect(url).toBe(`https://api.empresas.btgpactual.com/v1/companies/${taxId}/pix-cash-in/instant-collections`);
  expect(JSON.parse(options!.body as string)).toMatchObject({expiresIn:890,amount:{original:57.5,allowCustomerChangeValue:false},tags:{rastreiaOrderId:'order-1'}});expect(options!.redirect).toBe('error');
 });
 it.each(['tax','key','amount','variable','id','tx','location'])('rejects mismatched %s before exposing charge',kind=>{
  const c=structuredClone(charge);if(kind==='tax')c.taxId='11111111000111';if(kind==='key')c.pixKey='another-key';if(kind==='amount')c.amount.value=1;if(kind==='variable')c.amount.allowCustomerChangeValue=true;
  expect(()=>assertCharge(c,{taxId,pixKey:'pix-key',amountCents:5750,providerId:kind==='id'?'other':c.id,txId:kind==='tx'?'other':c.txId,locationId:kind==='location'?'other':c.location.id})).toThrow();
 });
 it('never retries POST on a timeout/unknown outcome',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout'));
  await expect(new BtgPixClient('private-token',taxId,fetcher).create({orderId:'o',pixKey:'k',amountCents:1,expiresIn:900})).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('queries paid charges without onlyActive and checks provider payload locally',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({data:[charge]})));
  expect(await new BtgPixClient('t',taxId,fetcher).find(new Date(),'location-1')).toHaveLength(1);
  expect(fetcher.mock.calls[0]![0]).toContain('locationId=location-1');expect(fetcher.mock.calls[0]![0]).not.toContain('onlyActive');
 });
 it('rejects malformed monetary fractions',()=>{expect(bankCents(57.5)).toBe(5750);expect(()=>bankCents(1.005)).toThrow();});
 it('does not echo provider error bodies',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response('secret banking information',{status:400}));
  await expect(new BtgPixClient('t',taxId,fetcher).validateAccount()).rejects.toMatchObject({code:'BTG_PIX_UNAVAILABLE'});
 });
});
