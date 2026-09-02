import { z } from 'zod';

export function validTaxId(value:string):boolean {
  const id=value.toUpperCase().replace(/[.\-/\s]/g,'');
  if(/^(.)\1+$/.test(id)) return false;
  if(/^\d{11}$/.test(id)) {
    for(let size=9;size<=10;size++) {
      const sum=[...id.slice(0,size)].reduce((total,digit,index)=>total+Number(digit)*(size+1-index),0);
      const digit=(sum*10)%11; if(Number(id[size])!==(digit===10?0:digit)) return false;
    } return true;
  }
  if(!/^[A-Z0-9]{12}\d{2}$/.test(id)) return false;
  // Receita Federal: ASCII minus 48 also preserves numeric CNPJ validation.
  for(let size=12;size<=13;size++) {
    const sum=[...id.slice(0,size)].reverse().reduce((total,char,index)=>total+(char.charCodeAt(0)-48)*(2+index%8),0);
    const remainder=sum%11; if(Number(id[size])!==(remainder<2?0:11-remainder)) return false;
  } return true;
}
export const moneySchema=z.string().regex(/^-?\d{1,9}\.\d{2}$/,'Use valor decimal com duas casas, por exemplo 150.00.');
export const cents=(value:string)=>BigInt(value.replace('.',''));
const nonNegativeMoney=moneySchema.refine(value=>cents(value)>=0n,'Valor não pode ser negativo.');
export const timezoneSchema=z.string().max(80).refine(value=>{
  try{new Intl.DateTimeFormat('pt-BR',{timeZone:value});return true;}catch{return false;}
},'Fuso horário inválido.');
export const billingProfileSchema=z.object({
  legalName:z.string().trim().min(2).max(200),tradeName:z.string().trim().min(2).max(160),
  taxId:z.string().trim().max(25).refine(validTaxId,'CPF/CNPJ inválido.').transform(value=>value.toUpperCase().replace(/[.\-/\s]/g,'')),
  stateRegistration:z.string().max(30).default(''),municipalRegistration:z.string().max(30).default(''),
  financialEmail:z.string().trim().email().toLowerCase(),financialPhone:z.string().max(30).default(''),
  financialContact:z.string().trim().min(2).max(160),
  billingAddress:z.object({addressLine:z.string().trim().min(3).max(240),number:z.string().max(30),
    complement:z.string().max(120).default(''),neighborhood:z.string().max(120),city:z.string().min(2).max(120),
    state:z.string().length(2),postalCode:z.string().regex(/^\d{5}-?\d{3}$/)}),
  planCode:z.string().trim().min(1).max(80),recurringAmount:nonNegativeMoney,additionalAmount:nonNegativeMoney.default('0.00'),
  dueDay:z.number().int().min(1).max(31),startsOn:z.iso.date(),periodicity:z.literal('MONTHLY').default('MONTHLY'),
  preferredPaymentMethod:z.string().trim().min(2).max(50).default('MANUAL'),graceDays:z.number().int().min(0).max(365).default(0),
  timezone:timezoneSchema.default('America/Sao_Paulo'),internalNotes:z.string().max(2000).default(''),enabled:z.boolean().default(false),
});
export const invoiceSchema=z.object({storeId:z.string().uuid(),period:z.iso.date().refine(value=>value.endsWith('-01'),'Competência deve iniciar no dia 01.'),
  chargeType:z.string().trim().min(2).max(50).default('SUBSCRIPTION'),description:z.string().trim().min(2).max(240),
  dueDate:z.iso.date(),items:z.array(z.object({description:z.string().trim().min(2).max(240),amount:moneySchema.refine(value=>cents(value)!==0n)})).min(1).max(100),
  reason:z.string().trim().min(5).max(500),
}).refine(value=>value.items.reduce((sum,item)=>sum+cents(item.amount),0n)>0n,{path:['items'],message:'O total deve ser positivo.'});
export type BillingProfileInput=z.infer<typeof billingProfileSchema>;
export type InvoiceInput=z.infer<typeof invoiceSchema>;
