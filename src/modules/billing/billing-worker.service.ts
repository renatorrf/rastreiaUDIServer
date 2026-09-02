import type { Database } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
import { reconcileFinancialHold, recordInvoiceState } from './billing.service.js';
import type { InvoiceRow } from './billing.types.js';

// Test callers can restrict the batch to a synthetic unit. Never create invoices for legacy units without a billing profile.
export async function processBillingBatch(database:Database,storeId?:string) {
  const stores=await database.query<{store_id:string}>(`SELECT store_id FROM rastreia.billing_profiles
    WHERE ($1::uuid IS NULL OR store_id=$1) ORDER BY store_id`,[storeId??null]);
  let notices=0,blocked=0,drafts=0;
  for(const {store_id} of stores.rows) {
    await withTransaction(database,async client=>{
      await client.query('SELECT id FROM rastreia.stores WHERE id=$1 FOR UPDATE',[store_id]);
      const profile=(await client.query(`SELECT profile.*,(now() AT TIME ZONE timezone)::date AS today,
        date_trunc('month',now() AT TIME ZONE timezone)::date AS current_period
        FROM rastreia.billing_profiles profile WHERE store_id=$1`,[store_id])).rows[0];
      if(profile.enabled && profile.starts_on<=profile.today) {
        const draft=await client.query(`INSERT INTO rastreia.invoices(tenant_id,store_id,period,description,due_date,timezone)
          SELECT $1,$2,$3,'Mensalidade '||$4,
          ($3::date + (LEAST($5,extract(day FROM ($3::date+interval '1 month - 1 day'))::integer)-1))::date,$6
          ON CONFLICT(store_id,period,charge_type) DO NOTHING RETURNING id`,
        [profile.tenant_id,store_id,profile.current_period,profile.plan_code,profile.due_day,profile.timezone]);
        if(draft.rowCount) {
          await client.query(`INSERT INTO rastreia.invoice_items(tenant_id,invoice_id,description,amount)
            SELECT $1,$2,'Mensalidade',$3::numeric WHERE $3::numeric>0
            UNION ALL SELECT $1,$2,'Adicionais',$4::numeric WHERE $4::numeric>0`,
          [profile.tenant_id,draft.rows[0].id,profile.recurring_amount,profile.additional_amount]);
          await client.query(`INSERT INTO rastreia.invoice_status_history(tenant_id,invoice_id,to_status,reason)
            VALUES($1,$2,'DRAFT','Geração mensal; aguarda emissão pelo Master.')`,[profile.tenant_id,draft.rows[0].id]);drafts++;
        }
      }
      const invoices=await client.query<InvoiceRow>(`SELECT invoice.*,
        ((now() AT TIME ZONE invoice.timezone)::date-invoice.due_date) AS days_overdue
        FROM rastreia.invoices invoice WHERE store_id=$1 AND status IN ('ISSUED','OVERDUE','DELINQUENT') FOR UPDATE`,[store_id]);
      for(const invoice of invoices.rows) {
        if(invoice.days_overdue>=5 && !invoice.delinquency_notified_at) {
          await recordInvoiceState(client,invoice,'DELINQUENT','Quinto dia corrido de atraso.');
          await client.query(`UPDATE rastreia.invoices SET delinquency_notified_at=now(),
            suspension_scheduled_at=GREATEST(now()+interval '24 hours',
              ((due_date+$2::integer)::timestamp AT TIME ZONE timezone)) WHERE id=$1`,[invoice.id,profile.grace_days]);
          await client.query(`INSERT INTO rastreia.billing_notifications(tenant_id,invoice_id,recipient_user_id,kind)
            SELECT $1,$2,membership.user_id,'DELINQUENCY' FROM rastreia.user_store_access access
            JOIN rastreia.tenant_users membership ON membership.id=access.tenant_user_id
            WHERE access.store_id=$3 AND membership.role='TENANT_MANAGER' AND membership.status='ACTIVE'
            ON CONFLICT(invoice_id,recipient_user_id,kind) DO NOTHING`,[profile.tenant_id,invoice.id,store_id]);notices++;
        } else if(invoice.days_overdue>0 && invoice.status==='ISSUED') {
          await recordInvoiceState(client,invoice,'OVERDUE','Vencimento sem quitação.');
        }
      }
      const next=(await client.query(`SELECT min(suspension_scheduled_at) AS scheduled FROM rastreia.invoices
        WHERE store_id=$1 AND status='DELINQUENT'`,[store_id])).rows[0].scheduled;
      if(next) {
        await client.query(`INSERT INTO rastreia.unit_financial_holds(tenant_id,store_id,scheduled_at,reason)
          VALUES($1,$2,$3,'Inadimplência de fatura emitida.') ON CONFLICT(store_id) DO UPDATE SET
          scheduled_at=EXCLUDED.scheduled_at,updated_at=now()`,[profile.tenant_id,store_id,next]);
        const result=await client.query(`UPDATE rastreia.unit_financial_holds SET blocked_at=now(),released_at=NULL,updated_at=now()
          WHERE store_id=$1 AND scheduled_at<=now() AND (waiver_until IS NULL OR waiver_until<=now())
          AND (blocked_at IS NULL OR released_at IS NOT NULL) RETURNING id`,[store_id]);
        if(result.rowCount) {
          await client.query(`INSERT INTO rastreia.platform_audit_logs(action,entity_type,entity_id,target_tenant_id,reason)
            VALUES('billing.hold_applied','store',$1,$2,'Prazo de regularização encerrado; novas operações bloqueadas.')`,[store_id,profile.tenant_id]);blocked++;
        }
      } else await reconcileFinancialHold(client,store_id);
    });
  }return {drafts,notices,blocked};
}
