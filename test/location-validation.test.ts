import { describe, expect, it } from 'vitest';
import { distanceMeters, shouldSampleLocation, validateLocationPoint } from '../src/modules/locations/location-validation.js';
import type { LocationPointInput } from '../src/modules/locations/location.types.js';

const base: LocationPointInput = {
  eventId: '11111111-1111-4111-8111-111111111111',
  deliveryId: '22222222-2222-4222-8222-222222222222',
  latitude: -23.5505,
  longitude: -46.6333,
  accuracy: 12,
  speed: 8,
  capturedAt: new Date('2026-08-19T02:00:00.000Z'),
};

describe('location validation', () => {
  it('calcula distância geográfica aproximada', () => {
    const distance = distanceMeters(base, { latitude: -23.5514, longitude: -46.6333 });
    expect(distance).toBeGreaterThan(95);
    expect(distance).toBeLessThan(105);
  });

  it('rejeita baixa precisão, futuro e pontos antigos', () => {
    const now = new Date('2026-08-19T02:00:10.000Z');
    expect(validateLocationPoint({ ...base, accuracy: 150 }, undefined, now)?.code).toBe('INACCURATE');
    expect(validateLocationPoint({ ...base, capturedAt: new Date('2026-08-19T02:01:00.000Z') }, undefined, now)?.code).toBe('FUTURE_TIMESTAMP');
    expect(validateLocationPoint({ ...base, capturedAt: new Date('2026-08-17T02:00:00.000Z') }, undefined, now)?.code).toBe('TOO_OLD');
  });

  it('rejeita salto impossível e ordem invertida', () => {
    const previous = { ...base, capturedAt: new Date('2026-08-19T01:59:50.000Z') };
    expect(validateLocationPoint({ ...base, latitude: -22.5505 }, previous, new Date('2026-08-19T02:00:05.000Z'))?.code).toBe('IMPOSSIBLE_JUMP');
    expect(validateLocationPoint({ ...base, capturedAt: previous.capturedAt }, previous, new Date('2026-08-19T02:00:05.000Z'))?.code).toBe('OUT_OF_ORDER');
  });

  it('amostra por tempo ou deslocamento', () => {
    const previous = { ...base, capturedAt: new Date('2026-08-19T01:59:30.000Z') };
    expect(shouldSampleLocation(base, previous)).toBe(true);
    expect(shouldSampleLocation({ ...base, capturedAt: new Date('2026-08-19T01:59:50.000Z') }, previous)).toBe(false);
  });
});
