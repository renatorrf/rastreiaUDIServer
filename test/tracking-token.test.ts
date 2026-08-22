import { describe, expect, it } from 'vitest';
import {
  abbreviateCourierName, canRevealDestination, generateTrackingToken, trackingTokenHash,
} from '../src/modules/tracking/tracking-token.js';

describe('tracking token', () => {
  it('gera 32 bytes em Base64URL sem padding', () => {
    const token = generateTrackingToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('usa HMAC determinístico e dependente do pepper', () => {
    const token = 'A'.repeat(43);
    const first = trackingTokenHash(token, 'pepper-one-with-at-least-thirty-two-characters');
    expect(first).toHaveLength(64);
    expect(trackingTokenHash(token, 'pepper-one-with-at-least-thirty-two-characters')).toBe(first);
    expect(trackingTokenHash(token, 'pepper-two-with-at-least-thirty-two-characters')).not.toBe(first);
  });

  it('protege o endereço antes do trajeto e abrevia o entregador', () => {
    expect(canRevealDestination('AWAITING_PICKUP')).toBe(false);
    expect(canRevealDestination('IN_ROUTE')).toBe(true);
    expect(abbreviateCourierName('Marina de Souza')).toBe('Marina S.');
    expect(abbreviateCourierName(null)).toBeNull();
  });
});
