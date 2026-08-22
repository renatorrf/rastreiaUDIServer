import { describe, expect, it } from 'vitest';
import {
  backgroundTrackingTokenHash, nativeLocationEventId,
} from '../src/modules/locations/background-tracking-token.js';

describe('background tracking credentials', () => {
  it('separa o HMAC por domínio e mantém a derivação estável', () => {
    const pepper = 'pepper-with-at-least-thirty-two-characters';
    expect(backgroundTrackingTokenHash('secret', pepper)).toHaveLength(64);
    expect(backgroundTrackingTokenHash('secret', pepper)).toBe(backgroundTrackingTokenHash('secret', pepper));
    expect(backgroundTrackingTokenHash('other', pepper)).not.toBe(backgroundTrackingTokenHash('secret', pepper));
  });

  it('deriva um UUID v5 determinístico para deduplicar o POST nativo e a fila JavaScript', () => {
    const point = { latitude: -23.55052, longitude: -46.633308, accuracy: 8.5, time: 1_777_000_000_123 };
    const eventId = nativeLocationEventId('11111111-1111-4111-8111-111111111111', point);
    expect(eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(nativeLocationEventId('11111111-1111-4111-8111-111111111111', point)).toBe(eventId);
    expect(nativeLocationEventId('22222222-2222-4222-8222-222222222222', point)).not.toBe(eventId);
  });
});
