import { z } from 'zod';
import { validTaxId, timezoneSchema, billingProfileSchema } from '../billing/billing.schemas.js';
import { storeSchema } from '../stores/store.routes.js';

export const groupSchema=z.object({name:z.string().trim().min(2).max(160),slug:z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),timezone:timezoneSchema.default('America/Sao_Paulo')});
export const companySchema=z.object({name:z.string().trim().min(2).max(160),legalName:z.string().trim().min(2).max(200),
  taxId:z.string().trim().refine(value=>value.replace(/[.\-/\s]/g,'').length===14&&validTaxId(value),'CNPJ inválido.')
    .transform(value=>value.toUpperCase().replace(/[.\-/\s]/g,''))});
export const managerSchema=z.object({name:z.string().trim().min(2).max(160),email:z.string().trim().email().toLowerCase()});
export const accessScopeSchema=z.object({level:z.enum(['TENANT','COMPANY','STORE']),tenantId:z.string().uuid(),
  companyId:z.string().uuid().optional(),storeId:z.string().uuid().optional(),validUntil:z.iso.datetime().optional()})
  .superRefine((v,ctx)=>{
    if((v.level==='TENANT'&&(v.companyId||v.storeId))||(v.level==='COMPANY'&&(!v.companyId||v.storeId))||(v.level==='STORE'&&(!v.companyId||!v.storeId)))
      ctx.addIssue({code:'custom',message:'Informe somente os identificadores correspondentes ao nível escolhido.'});
    if(v.validUntil&&new Date(v.validUntil)<=new Date())ctx.addIssue({code:'custom',path:['validUntil'],message:'A vigência deve terminar no futuro.'});
  });
export const provisionOrganizationSchema=z.object({group:groupSchema,manager:managerSchema,
  scope:z.object({level:z.enum(['TENANT','COMPANY','STORE']),targetKeys:z.array(z.string().min(1).max(60)).max(100).default([])}),
  companies:z.array(z.object({key:z.string().min(1).max(60),company:companySchema,
    units:z.array(z.object({key:z.string().min(1).max(60),store:storeSchema,billing:billingProfileSchema})).min(1).max(20)})).min(1).max(20),
}).superRefine((input,ctx)=>{
  const keys=input.companies.flatMap(company=>[company.key,...company.units.map(unit=>unit.key)]);
  const allowed=input.scope.level==='COMPANY'?input.companies.map(company=>company.key):input.companies.flatMap(company=>company.units.map(unit=>unit.key));
  if(new Set(keys).size!==keys.length)ctx.addIssue({code:'custom',path:['companies'],message:'Identificadores do formulário devem ser únicos.'});
  if(input.scope.level!=='TENANT'&&(!input.scope.targetKeys.length||input.scope.targetKeys.some(key=>!allowed.includes(key))))
    ctx.addIssue({code:'custom',path:['scope'],message:'Selecione empresas ou unidades válidas para o gestor.'});
  if(input.scope.level==='TENANT'&&input.scope.targetKeys.length)ctx.addIssue({code:'custom',path:['scope'],message:'Escopo de grupo não recebe empresas ou unidades selecionadas.'});
});
export const contextFilterSchema=z.object({tenantId:z.string().uuid().optional(),companyId:z.string().uuid().optional(),storeId:z.string().uuid().optional(),
  search:z.string().trim().max(160).default(''),status:z.enum(['ACTIVE','INACTIVE']).optional(),
  limit:z.coerce.number().int().min(1).max(100).default(25),offset:z.coerce.number().int().min(0).max(100000).default(0)});
