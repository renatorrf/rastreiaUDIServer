import { describe, expect, it } from 'vitest';
import { parseCreateDelivery } from '../src/modules/deliveries/delivery.routes.js';

const valid = {
  storeId: '11111111-1111-4111-8111-111111111111',
  recipientName: 'Cliente Teste',
  recipientPhone: '34999999999',
  addressLine: 'Avenida Brasil',
  city: 'Uberlândia',
  state: 'MG',
  latitude: -18.9186,
  longitude: -48.2772,
};

describe('delivery destination validation', () => {
  it('accepts finite coordinates selected for the delivery', () => {
    expect(parseCreateDelivery(valid)).toMatchObject({ latitude: -18.9186, longitude: -48.2772 });
  });

  it.each([
    [{ ...valid, latitude: null }],
    [{ ...valid, latitude: Number.NaN }],
    [{ ...valid, latitude: 0, longitude: 0 }],
    [{ ...valid, longitude: 181 }],
  ])('returns the domain 422 error for invalid coordinates', input => {
    expect(() => parseCreateDelivery(input)).toThrow(expect.objectContaining({
      statusCode: 422,
      code: 'DELIVERY_DESTINATION_COORDINATES_REQUIRED',
    }));
  });
});
