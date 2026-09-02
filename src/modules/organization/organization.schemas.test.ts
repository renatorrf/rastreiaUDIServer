import { describe, expect, it } from 'vitest';
import { accessScopeSchema, companySchema } from './organization.schemas.js';
import { operationsFilterSchema } from './operations.service.js';
const tenantId='00000000-0000-4000-8000-000000000001',companyId='00000000-0000-4000-8000-000000000002',storeId='00000000-0000-4000-8000-000000000003';
describe('organization contract validation',()=>{
  it('requires the exact identifiers for each access scope',()=>{
    for(const scope of [{level:'TENANT',tenantId},{level:'COMPANY',tenantId,companyId},{level:'STORE',tenantId,companyId,storeId}])expect(accessScopeSchema.safeParse(scope).success).toBe(true);
    for(const scope of [{level:'TENANT',tenantId,companyId},{level:'COMPANY',tenantId},{level:'STORE',tenantId,storeId}])expect(accessScopeSchema.safeParse(scope).success).toBe(false);
  });
  it('rejects expired grants and validates CNPJ rather than accepting CPF for a company',()=>{
    expect(accessScopeSchema.safeParse({level:'TENANT',tenantId,validUntil:'2020-01-01T00:00:00Z'}).success).toBe(false);
    expect(companySchema.parse({name:'Empresa',legalName:'Empresa jurídica',taxId:'11.222.333/0001-81'}).taxId).toBe('11222333000181');
    expect(companySchema.safeParse({name:'Empresa',legalName:'Empresa jurídica',taxId:'52998224725'}).success).toBe(false);
  });
  it('rejects inverted and unbounded reporting periods',()=>{
    expect(operationsFilterSchema.safeParse({from:'2026-01-01',to:'2026-12-31'}).success).toBe(true);
    expect(operationsFilterSchema.safeParse({from:'2026-01-01',to:'2025-12-31'}).success).toBe(false);
    expect(operationsFilterSchema.safeParse({from:'2025-01-01',to:'2026-12-31'}).success).toBe(false);
  });
});
