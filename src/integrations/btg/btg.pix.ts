import { z } from 'zod';
import { AppError } from '../../shared/errors.js';

// All network destinations are fixed: never fetch provider-supplied URLs/QR images.
export const pixBase = 'https://api.empresas.btgpactual.com/v1';
const amount = z.object({ value:z.number().finite().nonnegative(),allowCustomerChangeValue:z.boolean() });
export const bankCharge = z.object({id:z.string().min(1).max(200),txId:z.string().min(1).max(200),
 taxId:z.string(),status:z.string(),pixKey:z.string(),displayText:z.string().optional(),amount,
 emv:z.string().min(20).max(4096).optional(),location:z.object({id:z.string().min(1).max(200)}),
 paymentInfo:z.object({endToEndId:z.string().min(10).max(100),paymentDate:z.iso.datetime({offset:true}),paidAmount:z.number().positive()}).optional()});
export type BankCharge=z.infer<typeof bankCharge>;
export function bankCents(value:number){const cents=Math.round(value*100);if(!Number.isSafeInteger(cents)||Math.abs(value*100-cents)>0.00001)throw new Error('BTG_AMOUNT_INVALID');return cents;}
export function assertCharge(charge:BankCharge,expected:{taxId:string;pixKey:string;amountCents:number;providerId?:string|null;txId?:string|null;locationId?:string|null}){
 if(charge.taxId.replace(/\D/g,'')!==expected.taxId || charge.pixKey!==expected.pixKey || charge.amount.allowCustomerChangeValue || bankCents(charge.amount.value)!==expected.amountCents
 || (expected.providerId&&charge.id!==expected.providerId)||(expected.txId&&charge.txId!==expected.txId)||(expected.locationId&&charge.location.id!==expected.locationId))throw new Error('BTG_CHARGE_MISMATCH');
}
export class BtgPixClient {
 constructor(private readonly token:string,private readonly taxId:string,private readonly fetcher:typeof fetch=fetch){if(!/^\d{14}$/.test(taxId))throw new Error('BTG_CNPJ_REQUIRED');}
 private async request(path:string,body?:unknown){
  const response=await this.fetcher(`${pixBase}/companies/${this.taxId}/pix-cash-in/${path}`,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),
   headers:{Authorization:`Bearer ${this.token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw new AppError(502,'BTG_PIX_UNAVAILABLE','Não foi possível consultar o BTG. Tente novamente em instantes.');
  return response.json();
 }
 async validateAccount(){
  const result=z.object({data:z.array(z.object({taxId:z.string().optional()}))}).parse(await this.request('locations'));
  if(result.data.some(row=>row.taxId&&row.taxId.replace(/\D/g,'')!==this.taxId))throw new Error('BTG_ACCOUNT_MISMATCH');
 }
 async create(input:{orderId:string;pixKey:string;amountCents:number;expiresIn:number}){
  const charge=bankCharge.parse(await this.request('instant-collections',{pixKey:input.pixKey,expiresIn:input.expiresIn,
   amount:{original:input.amountCents/100,allowCustomerChangeValue:false},displayText:`Rastreia ${input.orderId}`,tags:{rastreiaOrderId:input.orderId}}));
  assertCharge(charge,{taxId:this.taxId,pixKey:input.pixKey,amountCents:input.amountCents});
  if(charge.status!=='ACTIVE'||!charge.emv)throw new Error('BTG_CHARGE_NOT_ACTIVE');
  return charge;
 }
 async find(createdAt:Date,locationId?:string|null){
  const query=new URLSearchParams({initialDate:new Date(createdAt.getTime()-86400000).toISOString().slice(0,10),finalDate:new Date(Date.now()+86400000).toISOString().slice(0,10)});
  if(locationId)query.set('locationId',locationId);
  return z.object({data:z.array(bankCharge)}).parse(await this.request(`instant-collections?${query.toString()}`)).data;
 }
}
