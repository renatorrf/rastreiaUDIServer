import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../config/env.js';
import type { RouteDirectionsProvider } from '../../integrations/geo/geo-provider.js';
import type { LocationStateStore } from '../locations/location-state.store.js';
import { getCustomerTracking } from './tracking.service.js';

const tenantId = '39f40c9d-4eb2-498a-b0b1-c41078097d48';
const customerId = 'b1d1700f-63ad-4458-854d-95151d09f749';
const deliveryId = '9c555c2b-6fe0-4c70-bd0d-3629556c3d85';

function dependencies() {
  const state = { getDelivery: vi.fn().mockResolvedValue(null) } as unknown as LocationStateStore;
  const calculateRoute = vi.fn();
  const directions = { calculateRoute } as unknown as RouteDirectionsProvider;
  const env = {
    TRACKING_COMPLETED_GRACE_SECONDS: 86_400,
    TRACKING_TOKEN_TTL_SECONDS: 86_400,
  } as AppEnv;
  return { state, directions, calculateRoute, env };
}

describe('customer authenticated tracking', () => {
  it('loads only the delivery linked to the authenticated customer', async () => {
    const now = new Date();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        tenantId, storeName: 'Loja parceira', storeContactPhone: '34999999999', externalReference: '9489',
        courierName: 'Entregador Teste', status: 'DELIVERED', addressLine: 'Rua das Flores', addressNumber: '109',
        neighborhood: 'Centro', city: 'Uberlândia', state: 'MG', postalCode: '38400-000',
        destinationLatitude: -18.91, destinationLongitude: -48.27, promisedWindowStart: null,
        promisedWindowEnd: null, deliveredAt: now, updatedAt: now, locationLatitude: null,
        locationLongitude: null, locationAccuracy: null, locationHeading: null, locationCapturedAt: null,
        proofId: null, proofRecipientName: null, proofCreatedAt: null, estimatedArrivalAt: null,
        etaCalculatedAt: null, hasPreviousStops: false, expiresAt: new Date(now.getTime() + 86_400_000),
      }] })
      .mockResolvedValueOnce({ rows: [{ status: 'DELIVERED', occurredAt: now }] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query } as unknown as PoolClient;
    const { state, directions, calculateRoute, env } = dependencies();

    const tracking = await getCustomerTracking(
      client, env, state, directions, tenantId, customerId, deliveryId,
    );

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('delivery.customer_profile_id = $2'), [
      deliveryId, customerId, tenantId, 86_400, 86_400,
    ]);
    expect(tracking).toMatchObject({ status: 'DELIVERED', reference: '9489', store: { name: 'Loja parceira' } });
    expect(calculateRoute).not.toHaveBeenCalled();
  });

  it('does not reveal an order that is not linked to the customer', async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [] }) } as unknown as PoolClient;
    const { state, directions, env } = dependencies();

    await expect(getCustomerTracking(
      client, env, state, directions, tenantId, customerId, deliveryId,
    )).rejects.toMatchObject({ statusCode: 404 });
  });
});
