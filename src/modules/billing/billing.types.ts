export interface InvoiceRow {
  id: string;
  tenant_id: string;
  store_id: string;
  status: 'DRAFT' | 'ISSUED' | 'OVERDUE' | 'DELINQUENT' | 'PAID' | 'CANCELLED';
  version: number;
  days_overdue: number;
  delinquency_notified_at: Date | null;
  suspension_scheduled_at: Date | null;
}

export interface InvoiceDetailRow extends InvoiceRow {
  total: string;
  paid: string;
  balance: string;
}

export interface BillingProfileRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  store_id: string;
  version: number;
  tax_id_encrypted: string;
}
