import { randomUUID } from 'node:crypto';
import type { Database } from '../../database/pool.js';
import { decryptPayload } from '../../shared/encrypted-payload.js';
import type { CancellationReason, ExternalEvent, ExternalOrderProvider } from '../external-orders/external-order-provider.js';
import own from './fixtures/order-own-delivery.json' with { type: 'json' };
import outsourced from './fixtures/order-ifood-delivery.json' with { type: 'json' };
import cash from './fixtures/order-cash.json' with { type: 'json' };
import prepaid from './fixtures/order-prepaid.json' with { type: 'json' };

export function mockOrder(scenario: 'own' | 'ifood' | 'cash' | 'prepaid' | 'cancelled' | 'duplicate', merchantId: string, id = randomUUID()) {
  const fixture = structuredClone(scenario === 'ifood' ? outsourced : scenario === 'cash' ? cash : scenario === 'prepaid' ? prepaid : own);
  fixture.id = id; fixture.displayId = id.slice(0,8); fixture.merchant.id = merchantId;
  fixture.delivery.deliveryDateTime = new Date(Date.now()+45*60_000).toISOString();
  return fixture;
}
export class MockIfoodProvider implements ExternalOrderProvider {
  constructor(private readonly db: Database, private readonly secret: string) {}
  async getOrder(id: string): Promise<unknown> {
    const row = (await this.db.query<{ payload_encrypted: string }>(`SELECT payload_encrypted FROM integration_events WHERE mode='mock' AND external_order_id=$1 AND event_code='PLC' ORDER BY received_at LIMIT 1`, [id])).rows[0];
    if (!row) throw new Error('MOCK_ORDER_NOT_FOUND');
    return decryptPayload<{ mockOrder: unknown }>(row.payload_encrypted, this.secret).mockOrder;
  }
  async getMerchant(id: string) { return { id, name: 'Loja simulada (sem conexão real)' }; }
  async pollEvents(): Promise<ExternalEvent[]> { return []; }
  async acknowledge(): Promise<void> {}
  async confirmOrder(): Promise<void> {}
  async startPreparation(): Promise<void> {}
  async dispatchOrder(): Promise<void> {}
  async getCancellationReasons(): Promise<CancellationReason[]> { return [{ cancellationCode: '501', description: 'Problemas operacionais (simulado)' }]; }
  async requestCancellation(): Promise<void> {}
}
