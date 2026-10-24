import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth.types.js';
import { writeAudit } from '../../shared/audit.js';
import { AppError,conflict,notFound } from '../../shared/errors.js';
import { requireCommerceStore } from './commerce.service.js';
import { assertVersion } from './inventory.service.js';
import type { financeEntry,financePayment,financeCategory,financeCancel,financeReverse,financeCost } from './finance.schemas.js';

// Classification is frozen with each entry; standard types are seeded only on an explicit write.
export const standardFinanceCategories=[
 ['Vendas avulsas','IN','REVENUE'],['Impostos sobre vendas','OUT','DEDUCTIONS'],['Descontos e devoluções de vendas','OUT','DEDUCTIONS'],
 ['CMV de vendas externas ao catálogo','OUT','COGS'],
 ['Taxas de cartão e marketplace','OUT','VARIABLE'],['Fretes e entregas','OUT','VARIABLE'],['Comissões','OUT','VARIABLE'],['Embalagens de venda','OUT','VARIABLE'],
 ['Aluguel','OUT','FIXED'],['Água e energia','OUT','FIXED'],['Internet e telefone','OUT','FIXED'],['Salários e encargos','OUT','FIXED'],['Pró-labore','OUT','FIXED'],
 ['Contabilidade e serviços','OUT','FIXED'],['Marketing','OUT','FIXED'],['Manutenção','OUT','FIXED'],['Softwares e assinaturas','OUT','FIXED'],
 ['Depreciação e amortização','OUT','DEPRECIATION'],['Rendimentos financeiros','IN','FINANCIAL_IN'],['Juros e tarifas bancárias','OUT','FINANCIAL_OUT'],['Tributos sobre lucro','OUT','PROFIT_TAX'],
 ['Compra de mercadorias / insumos','OUT','CASH_ONLY'],['Equipamentos e investimentos','OUT','CASH_ONLY'],['Retirada de lucros','OUT','CASH_ONLY'],['Amortização de empréstimos','OUT','CASH_ONLY'],['Aporte / empréstimo recebido','IN','CASH_ONLY']
] as const;
const audit=(c:PoolClient,a:AuthContext,action:string,id:string,input:unknown)=>writeAudit(c,{tenantId:a.tenantId,actorUserId:a.userId,action:'commerce.finance.'+action,entityType:'commerce_finance',entityId:id,afterData:input});
export async function seedFinanceCategories(c:PoolClient,a:AuthContext,store:string){
 await requireCommerceStore(c,store);
 for(const [name,direction,group] of standardFinanceCategories)await c.query('INSERT INTO commerce_finance_categories(tenant_id,store_id,name,direction,dre_group) VALUES($1,$2,$3,$4,$5) ON CONFLICT(store_id,name) DO NOTHING',[a.tenantId,store,name,direction,group]);
 await audit(c,a,'categories.initialized',store,{});return {ok:true};
}
export async function createFinanceCategory(c:PoolClient,a:AuthContext,store:string,input:z.infer<typeof financeCategory>){
 await requireCommerceStore(c,store);
 const row=(await c.query<{id:string}>('INSERT INTO commerce_finance_categories(tenant_id,store_id,name,direction,dre_group) VALUES($1,$2,$3,$4,$5) RETURNING id',[a.tenantId,store,input.name,input.direction,input.dreGroup])).rows[0]!;
 await audit(c,a,'category.created',row.id,input);return row;
}
export async function createFinanceEntry(c:PoolClient,a:AuthContext,store:string,input:z.infer<typeof financeEntry>){
 await requireCommerceStore(c,store);
 const cat=(await c.query('SELECT * FROM commerce_finance_categories WHERE id=$1 AND store_id=$2',[input.categoryId,store])).rows[0];if(!cat)throw notFound('Tipo de lançamento não encontrado.');
 const row=(await c.query<{id:string}>(`INSERT INTO commerce_finance_entries(tenant_id,store_id,category_id,description,direction,dre_group,amount_cents,competence_date,due_date,document,created_by)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,[a.tenantId,store,input.categoryId,input.description,cat.direction,cat.dre_group,input.amountCents,input.competenceDate,input.dueDate,input.document,a.userId])).rows[0]!;
 await audit(c,a,'entry.created',row.id,input);return row;
}
async function lockEntry(c:PoolClient,store:string,id:string,version:number){
 await requireCommerceStore(c,store);const row=(await c.query('SELECT * FROM commerce_finance_entries WHERE id=$1 AND store_id=$2 FOR UPDATE',[id,store])).rows[0];
 if(!row)throw notFound('Lançamento não encontrado.');assertVersion(Number(row.version),version);if(row.cancelled_at)throw conflict('Lançamento cancelado.');return row;
}
export async function settleFinanceEntry(c:PoolClient,a:AuthContext,store:string,id:string,input:z.infer<typeof financePayment>){
 const entry=await lockEntry(c,store,id,input.expectedVersion);
 const paid=Number((await c.query('SELECT coalesce(sum(amount_cents),0) AS paid FROM commerce_finance_settlements WHERE entry_id=$1 AND reversed_date IS NULL',[id])).rows[0]!.paid);
 if(input.amountCents>Number(entry.amount_cents)-paid)throw conflict('A baixa excede o saldo em aberto. Atualize o lançamento.');
 if(input.paidDate>today())throw conflict('Use a data efetiva do pagamento, não uma data futura.');
 if(['DEPRECIATION','COGS'].includes(String(entry.dre_group)))throw conflict('A apropriação de custo/depreciação não movimenta caixa. Registre a compra separadamente.');
 const row=(await c.query<{id:string}>(`INSERT INTO commerce_finance_settlements(tenant_id,store_id,entry_id,amount_cents,paid_date,method,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[a.tenantId,store,id,input.amountCents,input.paidDate,input.method,input.note,a.userId])).rows[0]!;
 await c.query('UPDATE commerce_finance_entries SET version=version+1 WHERE id=$1',[id]);await audit(c,a,'settlement.created',row.id,input);return row;
}
export async function cancelFinanceEntry(c:PoolClient,a:AuthContext,store:string,id:string,input:z.infer<typeof financeCancel>){
 const entry=await lockEntry(c,store,id,input.expectedVersion);if(entry.order_id)throw conflict('A venda concluída não pode ser apagada. Registre a devolução como dedução separada.');
 if((await c.query('SELECT id FROM commerce_finance_settlements WHERE entry_id=$1 AND reversed_date IS NULL LIMIT 1',[id])).rowCount)throw conflict('Estorne as baixas antes de cancelar o lançamento.');
 await c.query('UPDATE commerce_finance_entries SET cancelled_at=now(),cancel_reason=$2,version=version+1 WHERE id=$1',[id,input.reason]);await audit(c,a,'entry.cancelled',id,input);return {ok:true};
}
export async function reverseFinanceSettlement(c:PoolClient,a:AuthContext,store:string,entryId:string,id:string,input:z.infer<typeof financeReverse>){
 await lockEntry(c,store,entryId,input.expectedVersion);
 const payment=(await c.query('SELECT id,paid_date::text,reversed_date FROM commerce_finance_settlements WHERE id=$1 AND entry_id=$2 AND store_id=$3 FOR UPDATE',[id,entryId,store])).rows[0];
 if(!payment)throw notFound('Baixa não encontrada.');if(payment.reversed_date)throw conflict('Esta baixa já foi estornada.');
 if(input.reversedDate<payment.paid_date||input.reversedDate>today())throw conflict('O estorno deve ocorrer entre a data da baixa e hoje.');
 await c.query('UPDATE commerce_finance_settlements SET reversed_date=$2,reverse_reason=$3 WHERE id=$1',[id,input.reversedDate,input.reason]);
 await c.query('UPDATE commerce_finance_entries SET version=version+1 WHERE id=$1',[entryId]);await audit(c,a,'settlement.reversed',id,input);return {ok:true};
}
export async function initializeFinanceCost(c:PoolClient,a:AuthContext,store:string,id:string,input:z.infer<typeof financeCost>){
 await requireCommerceStore(c,store);
 try{await c.query('SELECT commerce_finance_initialize_cost($1,$2,$3,$4)',[id,store,input.expectedVersion,input.unitCostCents]);}
 catch(e){const code=(e as {code?:string}).code;if(code==='40001')throw new AppError(409,'VERSION_CONFLICT','O estoque mudou. Atualize antes de confirmar.');if(code==='23514')throw conflict('O saldo já possui custo médio. Novas entradas recalculam esse custo.');if(code==='P0002')throw notFound();throw e;}
 await audit(c,a,'opening_cost.initialized',id,input);return {ok:true};
}
export const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const n=(value:unknown)=>{const number=Number(value??0);if(!Number.isSafeInteger(number))throw new AppError(422,'FINANCE_LIMIT','Valor agregado excede o limite suportado. Reduza o período.');return number;};
export async function financeReport(c:PoolClient,store:string,from:string,to:string){
 await requireCommerceStore(c,store);
 const sales=(await c.query(`SELECT count(*) AS orders,coalesce(sum(revenue_cents),0) AS revenue,coalesce(sum(known_cost_cents),0) AS cost,
 coalesce(sum(unknown_cost_items),0) AS unknown,count(*) FILTER(WHERE legacy) AS legacy FROM commerce_finance_sales WHERE store_id=$1 AND recognized_date BETWEEN $2 AND $3`,[store,from,to])).rows[0]!;
 const groups=(await c.query(`SELECT dre_group,direction,sum(amount_cents) AS amount FROM commerce_finance_entries WHERE store_id=$1 AND competence_date BETWEEN $2 AND $3 AND cancelled_at IS NULL AND order_id IS NULL GROUP BY dre_group,direction`,[store,from,to])).rows;
 const amount=(group:string):number=>groups.filter(r=>r.dre_group===group).reduce<number>((sum,r)=>sum+n(r.amount),0);
 const movements=(await c.query(`SELECT coalesce(round(sum(CASE WHEN delta<0 THEN -delta*unit_cost_cents ELSE 0 END)),0) AS loss,
 coalesce(round(sum(CASE WHEN delta>0 AND kind='ADJUSTMENT' THEN delta*unit_cost_cents ELSE 0 END)),0) AS gain,
 count(*) FILTER(WHERE unit_cost_cents IS NULL) AS unknown FROM commerce_inventory_movements WHERE store_id=$1 AND order_id IS NULL
 AND (delta<0 OR kind='ADJUSTMENT') AND created_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND created_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`,[store,from,to])).rows[0]!;
 const unknown=n(sales.unknown)+n(movements.unknown),gross=n(sales.revenue)+amount('REVENUE'),net=gross-amount('DEDUCTIONS'),cost=n(sales.cost)+amount('COGS'),grossProfit=net-cost;
 const ebitda=grossProfit-amount('VARIABLE')-amount('FIXED')-n(movements.loss)+n(movements.gain),ebit=ebitda-amount('DEPRECIATION'),beforeTax=ebit+amount('FINANCIAL_IN')-amount('FINANCIAL_OUT');
 const line=(code:string,label:string,value:number,subtotal=false,needsCost=false)=>({code,label,amountCents:needsCost&&unknown?null:n(value),subtotal});
 const dre=[line('REVENUE','Receita bruta',gross),line('DEDUCTIONS','Deduções e impostos sobre vendas',-amount('DEDUCTIONS')),line('NET_REVENUE','Receita líquida',net,true),
 line('COGS','Custo das mercadorias vendidas',-cost,false,n(sales.unknown)>0),line('GROSS_PROFIT','Lucro bruto',grossProfit,true,n(sales.unknown)>0),line('VARIABLE','Despesas variáveis',-amount('VARIABLE')),
 line('FIXED','Despesas fixas',-amount('FIXED')),line('STOCK_LOSS','Perdas e saídas não comerciais',-n(movements.loss),false,n(movements.unknown)>0),line('STOCK_GAIN','Ajustes positivos de estoque',n(movements.gain),false,n(movements.unknown)>0),
 line('EBITDA','Resultado antes de depreciação (EBITDA)',ebitda,true,true),line('DEPRECIATION','Depreciação e amortização',-amount('DEPRECIATION')),line('EBIT','Resultado operacional',ebit,true,true),
 line('FINANCIAL_IN','Receitas financeiras',amount('FINANCIAL_IN')),line('FINANCIAL_OUT','Despesas financeiras',-amount('FINANCIAL_OUT')),line('BEFORE_TAX','Resultado antes dos tributos sobre lucro',beforeTax,true,true),
 line('PROFIT_TAX','Tributos sobre lucro',-amount('PROFIT_TAX')),line('NET_PROFIT','Resultado líquido',beforeTax-amount('PROFIT_TAX'),true,true)];
 const cash=(await c.query(`WITH flows AS (
 SELECT s.paid_date AS day,e.direction,s.amount_cents AS amount FROM commerce_finance_settlements s JOIN commerce_finance_entries e ON e.id=s.entry_id WHERE s.store_id=$1
 UNION ALL SELECT s.reversed_date,e.direction,-s.amount_cents FROM commerce_finance_settlements s JOIN commerce_finance_entries e ON e.id=s.entry_id WHERE s.store_id=$1 AND s.reversed_date IS NOT NULL)
 SELECT coalesce(sum(amount) FILTER(WHERE direction='IN'),0) AS incoming,coalesce(sum(amount) FILTER(WHERE direction='OUT'),0) AS outgoing FROM flows WHERE day BETWEEN $2 AND $3`,[store,from,to])).rows[0]!;
 const outstanding=(await c.query(`WITH balances AS (SELECT e.direction,e.due_date,e.amount_cents-coalesce((SELECT sum(s.amount_cents) FROM commerce_finance_settlements s WHERE s.entry_id=e.id AND s.reversed_date IS NULL),0) AS balance
 FROM commerce_finance_entries e WHERE e.store_id=$1 AND e.cancelled_at IS NULL AND e.dre_group NOT IN ('DEPRECIATION','COGS'))
 SELECT coalesce(sum(balance) FILTER(WHERE direction='IN'),0) AS receivable,coalesce(sum(balance) FILTER(WHERE direction='OUT'),0) AS payable,
 coalesce(sum(balance) FILTER(WHERE direction='OUT' AND due_date<$2),0) AS overdue FROM balances`,[store,today()])).rows[0]!;
 const inventory=(await c.query(`SELECT coalesce(round(sum(b.on_hand*b.average_cost_cents)),0) AS cost,coalesce(sum(b.on_hand),0) AS units,
 coalesce(sum(b.reserved),0) AS reserved,coalesce(sum((b.on_hand-b.reserved)*v.price_cents::bigint) FILTER(WHERE v.active AND p.active),0) AS potential,
 coalesce(round(sum((b.on_hand-b.reserved)*b.average_cost_cents) FILTER(WHERE v.active AND p.active)),0) AS available_cost,
 count(*) FILTER(WHERE b.on_hand>0 AND b.average_cost_cents IS NULL) AS unknown,
 coalesce(sum(b.on_hand) FILTER(WHERE NOT v.active OR NOT p.active),0) AS inactive_units
 FROM commerce_inventory_balances b JOIN commerce_variants v ON v.id=b.variant_id JOIN commerce_products p ON p.id=v.product_id WHERE b.store_id=$1 AND p.stock_mode='STOCKED'`,[store])).rows[0]!;
 return {from,to,timezone:'America/Sao_Paulo',dre,orders:n(sales.orders),unknownCostItems:unknown,legacyOrders:n(sales.legacy),knownCostCents:cost,
 cash:{incomingCents:n(cash.incoming),outgoingCents:n(cash.outgoing),netCents:n(cash.incoming)-n(cash.outgoing)},
 outstanding:{receivableCents:n(outstanding.receivable),payableCents:n(outstanding.payable),overdueCents:n(outstanding.overdue)},
 inventory:{knownCostCents:n(inventory.cost),unknownVariants:n(inventory.unknown),units:n(inventory.units),reserved:n(inventory.reserved),inactiveUnits:n(inventory.inactive_units),potentialRevenueCents:n(inventory.potential),potentialMarginCents:n(inventory.unknown)?null:n(inventory.potential)-n(inventory.available_cost)}};
}
export async function financeEntries(c:PoolClient,store:string,from:string,to:string,limit:number,offset:number){
 await requireCommerceStore(c,store);const values=[store,from,to];
 const where='e.store_id=$1 AND e.competence_date BETWEEN $2 AND $3';
 const data=(await c.query(`SELECT e.id,e.description,e.direction,e.dre_group AS "dreGroup",e.amount_cents::float8 AS "amountCents",e.competence_date::text AS "competenceDate",e.due_date::text AS "dueDate",e.document,e.version,e.order_id AS "orderId",e.cancelled_at AS "cancelledAt",e.cancel_reason AS "cancelReason",c.name AS "categoryName",
 coalesce((SELECT sum(s.amount_cents)::float8 FROM commerce_finance_settlements s WHERE s.entry_id=e.id AND s.reversed_date IS NULL),0) AS "paidCents"
 FROM commerce_finance_entries e LEFT JOIN commerce_finance_categories c ON c.id=e.category_id WHERE ${where} ORDER BY e.competence_date DESC,e.created_at DESC,e.id LIMIT $4 OFFSET $5`,[...values,limit,offset])).rows;
 return {data,total:n((await c.query(`SELECT count(*) AS count FROM commerce_finance_entries e WHERE ${where}`,values)).rows[0]!.count)};
}
