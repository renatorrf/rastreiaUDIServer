import { z } from 'zod';
import type { CreateDeliveryInput } from '../../modules/deliveries/delivery.service.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const amount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const date = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export function normalizeIfoodOrder(raw: unknown) {
  const o = record(raw), merchant = record(o['merchant']), delivery = record(o['delivery']), customer = record(o['customer']);
  const address = record(delivery['deliveryAddress']), coordinates = record(address['coordinates']), payments = record(o['payments']), total = record(o['total']);
  return {
    id: z.uuid().parse(o['id']), merchantId: z.uuid().parse(merchant['id']), displayId: text(o['displayId']),
    orderType: text(o['orderType']), deliveredBy: text(delivery['deliveredBy']),
    ownDelivery: o['orderType'] === 'DELIVERY' && delivery['deliveredBy'] === 'MERCHANT',
    customer: { name: text(customer['name']), phone: text(record(customer['phone'])['number']), phoneLocalizer: text(record(customer['phone'])['localizer']) },
    address: { street: text(address['streetName']), number: text(address['streetNumber']), complement: text(address['complement']),
      reference: text(address['reference']), neighborhood: text(address['neighborhood']), city: text(address['city']), state: text(address['state']),
      postalCode: text(address['postalCode']), latitude: coordinates['latitude'], longitude: coordinates['longitude'] },
    observations: text(o['observations']), readyAt: date(o['preparationStartDateTime']),
    expectedAt: date(delivery['deliveryDateTime']) ?? date(record(o['schedule'])['deliveryDateTimeStart']),
    items: list(o['items']).map(value => { const item = record(value); return { name: text(item['name']), quantity: item['quantity'],
      observations: text(item['observations']), unitPriceCents: amount(item['unitPrice']), totalCents: amount(item['totalPrice']),
      options: list(item['options']).map(option => { const extra = record(option); return { name: text(extra['name']), quantity: extra['quantity'], priceCents: amount(extra['price']) }; }) }; }),
    payments: list(payments['methods']).map(value => { const payment = record(value); return { method: text(payment['method']), type: text(payment['type']),
      prepaid: payment['prepaid'] === true, valueCents: amount(payment['value']), cashChangeForCents: amount(record(payment['cash'])['changeFor']) }; }),
    totalCents: amount(total['orderAmount']), deliveryFeeCents: amount(total['deliveryFee']), discountCents: amount(total['benefits']),
    benefits: list(o['benefits']).map(value => { const benefit = record(value); return { valueCents: amount(benefit['value']), target: text(benefit['target']) }; }),
  };
}
export type NormalizedIfoodOrder = ReturnType<typeof normalizeIfoodOrder>;
/** Missing coordinates/address never silently become a fabricated destination. */
export function deliveryInput(order: NormalizedIfoodOrder, storeId: string): CreateDeliveryInput {
  const a = order.address;
  const destination = z.object({ street: z.string().min(3).max(240), city: z.string().min(2).max(120), state: z.string().length(2),
    latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).parse(a);
  return { storeId, recipientName: z.string().min(2).max(160).parse(order.customer.name),
    recipientPhone: z.string().min(8).max(30).parse(order.customer.phone), externalReference: order.displayId || order.id,
    addressLine: destination.street, addressNumber: a.number.slice(0,30), complement: a.complement.slice(0,120),
    neighborhood: a.neighborhood.slice(0,120), city: destination.city, state: destination.state, postalCode: a.postalCode.slice(0,12),
    latitude: destination.latitude, longitude: destination.longitude,
    deliveryInstructions: [a.reference, order.observations, order.customer.phoneLocalizer ? `Localizador do telefone: ${order.customer.phoneLocalizer}` : ''].filter(Boolean).join(' | ').slice(0,1000),
    promisedWindowEnd: order.expectedAt ? new Date(order.expectedAt) : null };
}
