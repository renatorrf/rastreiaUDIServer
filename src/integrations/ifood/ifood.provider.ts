import { z } from 'zod';
import type { CancellationReason, ExternalOrderProvider } from '../external-orders/external-order-provider.js';
import { IfoodClient } from './ifood.client.js';

export const ifoodEventSchema = z.object({
  id: z.string().min(1).max(120), merchantId: z.uuid(), orderId: z.uuid(),
  code: z.string().min(1).max(80), fullCode: z.string().max(120).default(''), createdAt: z.iso.datetime({ offset: true }),
});
export const cancellationReasonsSchema = z.object({ reasons: z.array(z.object({ code: z.string(), description: z.string() })) });
/** Contracts verified against the iFood Events and Order guides; see docs/ifood-integration.md. */
export class IfoodProvider implements ExternalOrderProvider {
  constructor(private readonly client: IfoodClient) {}
  getOrder(id: string) { return this.client.request(`/order/v1.0/orders/${encodeURIComponent(id)}`); }
  async getMerchant(id: string) { return z.object({ id: z.uuid(), name: z.string() }).parse(await this.client.request(`/merchant/v1.0/merchants/${encodeURIComponent(id)}`)); }
  async pollEvents(ids: string[]) {
    if (!ids.length) return [];
    const response = await this.client.request('/events/v1.0/events:polling?excludeHeartbeat=true', 'GET', undefined, { 'x-polling-merchants': ids.slice(0, 100).join(',') });
    return z.array(ifoodEventSchema.passthrough()).parse(response ?? []);
  }
  async acknowledge(ids: string[]) { if (ids.length) await this.client.request('/events/v1.0/events/acknowledgment', 'POST', [...new Set(ids)].map(id => ({ id }))); }
  async confirmOrder(id: string) { await this.client.request(`/order/v1.0/orders/${encodeURIComponent(id)}/confirm`, 'POST'); }
  async startPreparation(id: string) { await this.client.request(`/order/v1.0/orders/${encodeURIComponent(id)}/startPreparation`, 'POST'); }
  async dispatchOrder(id: string) { await this.client.request(`/order/v1.0/orders/${encodeURIComponent(id)}/dispatch`, 'POST', { deliveredBy: 'MERCHANT' }); }
  async getCancellationReasons(id: string) { return cancellationReasonsSchema.parse(await this.client.request(`/order/v1.0/orders/${encodeURIComponent(id)}/cancellationReasons`)).reasons.map(r=>({cancellationCode:r.code,description:r.description})); }
  async requestCancellation(id: string, reason: CancellationReason) { await this.client.request(`/order/v1.0/orders/${encodeURIComponent(id)}/requestCancellation`, 'POST', {reason:reason.cancellationCode}); }
}
