import { z } from 'zod';
export const financeGroups=['REVENUE','DEDUCTIONS','COGS','VARIABLE','FIXED','DEPRECIATION','FINANCIAL_IN','FINANCIAL_OUT','PROFIT_TAX','CASH_ONLY'] as const;
export const financeDate=z.iso.date().refine(value=>value>='2000-01-01'&&value<='2100-12-31','Informe uma data entre 2000 e 2100.');
export const financePeriod=z.object({from:financeDate,to:financeDate}).strict().refine(v=>v.to>=v.from&&(Date.parse(v.to)-Date.parse(v.from))/86400000<=365,'Selecione um período de até 366 dias.');
export const financePage=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(100000).default(0)});
export const financeCategory=z.object({name:z.string().trim().min(2).max(100),direction:z.enum(['IN','OUT']),dreGroup:z.enum(financeGroups)}).strict()
 .refine(v=>v.direction==='IN'?['REVENUE','FINANCIAL_IN','CASH_ONLY'].includes(v.dreGroup):!['REVENUE','FINANCIAL_IN'].includes(v.dreGroup),'Classificação incompatível com entrada/saída.');
export const financeEntry=z.object({categoryId:z.uuid(),description:z.string().trim().min(3).max(200),amountCents:z.number().int().min(1).max(100000000),competenceDate:financeDate,dueDate:financeDate,document:z.string().trim().max(120).default('')}).strict();
export const financePayment=z.object({expectedVersion:z.number().int().positive(),amountCents:z.number().int().min(1).max(100000000000),paidDate:financeDate,method:z.enum(['PIX','CASH','CARD','TRANSFER','OTHER']),note:z.string().trim().max(500).default('')}).strict();
export const financeCancel=z.object({expectedVersion:z.number().int().positive(),reason:z.string().trim().min(5).max(500)}).strict();
export const financeReverse=financeCancel.extend({reversedDate:financeDate});
export const financeCost=z.object({expectedVersion:z.number().int().positive(),unitCostCents:z.number().int().min(0).max(100000000),reason:z.string().trim().min(5).max(500)}).strict();
