import type { PoolClient } from 'pg';
import type { CreateDeliveryInput } from '../deliveries/delivery.service.js';
import { normalizeCustomerPhone } from './customer-phone.js';

export type CustomerOrderData = Omit<CreateDeliveryInput, 'storeId'>;

/** Reuse a tenant-local contact without changing customer-owned data or consent. */
export async function preregisterCustomer(client: PoolClient, tenantId: string, input: CustomerOrderData): Promise<string | null> {
  const phone = normalizeCustomerPhone(input.recipientWhatsapp || input.recipientPhone);
  if (!/^[1-9]\d{9,10}$/.test(phone)) return null;
  const [firstName = '', ...surname] = input.recipientName.trim().split(/\s+/);
  if (firstName.length < 2) return null;
  const result = await client.query<{ id: string }>(`
    INSERT INTO customer_profiles(tenant_id,first_name,last_name,whatsapp,whatsapp_normalized,
      address_line,address_number,complement,neighborhood,city,state,postal_code,latitude,longitude,
      address_confidence,consent_at,last_order_at)
    VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,now())
    ON CONFLICT(tenant_id,whatsapp_normalized) DO UPDATE SET last_order_at=now()
      WHERE customer_profiles.status='ACTIVE'
    RETURNING id`, [tenantId,firstName.slice(0,80),surname.join(' ').slice(0,120),phone,
    input.addressLine,input.addressNumber ?? '',input.complement ?? null,input.neighborhood ?? '',
    input.city,input.state,input.postalCode ?? '',input.latitude,input.longitude,input.addressConfidence ?? null]);
  return result.rows[0]?.id ?? null;
}
