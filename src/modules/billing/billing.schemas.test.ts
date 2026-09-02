import { describe, expect, it } from 'vitest';
import { cents, invoiceSchema, moneySchema, timezoneSchema, validTaxId } from './billing.schemas.js';
import { courierPreferencesSchema } from '../couriers/courier-account.routes.js';

describe('billing validation',()=>{
  it('validates check digits for CPF and numeric/alphanumeric CNPJ',()=>{
    for(const value of ['529.982.247-25','11.222.333/0001-81','12.ABC.345/01DE-35'])expect(validTaxId(value)).toBe(true);
    for(const value of ['11111111111','00000000000000','52998224724','12ABC34501DE36','ABC'])expect(validTaxId(value)).toBe(false);
  });
  it('uses exact cents and rejects floating-point or ambiguous values',()=>{
    expect(cents('0.10')+cents('0.20')).toBe(30n);
    expect(cents('-5.00')).toBe(-500n);
    for(const value of [1.23,'1,23','1.234','1e3','1','NaN'])expect(moneySchema.safeParse(value).success).toBe(false);
  });
  it('requires real dates, first-day accounting period and positive totals',()=>{
    const invoice={storeId:'7acb91f0-a129-4ad6-86ef-a53c917fb31a',period:'2026-09-01',dueDate:'2026-09-10',
      description:'Plano mensal',items:[{description:'Mensalidade',amount:'100.00'},{description:'Desconto',amount:'-10.00'}],reason:'Teste válido'};
    expect(invoiceSchema.safeParse(invoice).success).toBe(true);
    expect(invoiceSchema.safeParse({...invoice,period:'2026-09-02'}).success).toBe(false);
    expect(invoiceSchema.safeParse({...invoice,dueDate:'2026-02-30'}).success).toBe(false);
    expect(invoiceSchema.safeParse({...invoice,items:[{description:'Desconto',amount:'-10.00'}]}).success).toBe(false);
    expect(timezoneSchema.safeParse('America/Sao_Paulo').success).toBe(true);
    expect(timezoneSchema.safeParse('Fuso-inexistente').success).toBe(false);
  });
  it('validates service radius, modalities and availability intervals',()=>{
    const input={baseCity:'Uberlândia',radiusM:5000,modalities:['ONE_OFF'],availabilityWindows:[{day:1,start:'08:00',end:'18:00'}]};
    expect(courierPreferencesSchema.safeParse(input).success).toBe(true);
    expect(courierPreferencesSchema.safeParse({...input,radiusM:100001}).success).toBe(false);
    expect(courierPreferencesSchema.safeParse({...input,modalities:[]}).success).toBe(false);
    expect(courierPreferencesSchema.safeParse({...input,availabilityWindows:[{day:8,start:'25:00',end:'10:00'}]}).success).toBe(false);
    expect(courierPreferencesSchema.safeParse({...input,availabilityWindows:[{day:1,start:'18:00',end:'08:00'}]}).success).toBe(false);
  });
});
