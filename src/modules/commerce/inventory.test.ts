import { describe,it,expect } from 'vitest';
import { storefrontPublicUrl } from './inventory.service.js';
import { adjustmentSchema,variantSchema,storefrontSchema } from './inventory.schemas.js';
describe('inventory contracts',()=>{
  it('derives a public frontend link independent of the native app origin',()=>{
    expect(storefrontPublicUrl('https://app.example.test/rastrear','loja-teste')).toBe('https://app.example.test/loja/loja-teste');
    expect(storefrontPublicUrl(undefined,'loja')).toBeNull();expect(storefrontPublicUrl('javascript:alert(1)','loja')).toBeNull();
  });
  it('rejects injected ownership, quantities and an empty confirmation',()=>{
    const input={variantId:'00000000-0000-4000-8000-000000000001',expectedVersion:1,delta:1,kind:'ENTRY',reason:'Contagem de teste',confirmationPassword:'test'};
    expect(adjustmentSchema.safeParse(input).success).toBe(true);
    for(const patch of [{tenantId:'other'},{delta:0},{delta:1.5},{delta:-1},{confirmationPassword:''},{kind:'LOSS'}])expect(adjustmentSchema.safeParse({...input,...patch}).success).toBe(false);
  });
  it('accepts negative losses but not invented reservation writes',()=>{
    expect(adjustmentSchema.safeParse({variantId:'00000000-0000-4000-8000-000000000001',expectedVersion:1,delta:-2,kind:'LOSS',reason:'Avaria no estoque',confirmationPassword:'test'}).success).toBe(true);
    expect(variantSchema.safeParse({name:'P',sku:'P',priceCents:100,costCents:50,minimumStock:0,active:true,reserved:5}).success).toBe(false);
  });
  it('requires an explicit publication flag and a safe stable slug',()=>{
    const input={slug:'loja-teste',title:'Loja teste',description:'',published:false,expectedVersion:0};
    expect(storefrontSchema.safeParse(input).success).toBe(true);
    for(const slug of ['../store','LOJA','-loja','loja-','ab'])expect(storefrontSchema.safeParse({...input,slug}).success).toBe(false);
  });
});
