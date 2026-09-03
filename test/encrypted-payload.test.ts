import { describe, expect, it } from 'vitest';
import { decryptPayload, encryptPayload } from '../src/shared/encrypted-payload.js';

describe('encrypted payload', () => {
  it('round-trips a sensitive message without plaintext in storage', () => {
    const value = { to: '+5511999999999', trackingUrl: 'https://example.test/rastrear/secret' };
    const encrypted = encryptPayload(value, 'a-secure-test-secret-with-more-than-32-characters');
    expect(encrypted).not.toContain(value.to);
    expect(encrypted).not.toContain('secret');
    expect(decryptPayload(encrypted, 'a-secure-test-secret-with-more-than-32-characters')).toEqual(value);
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = encryptPayload({ ok: true }, 'a-secure-test-secret-with-more-than-32-characters');
    const index = Math.floor(encrypted.length / 2);
    const replacement = encrypted[index] === 'A' ? 'B' : 'A';
    const tampered = `${encrypted.slice(0, index)}${replacement}${encrypted.slice(index + 1)}`;
    expect(() => decryptPayload(tampered,
      'a-secure-test-secret-with-more-than-32-characters')).toThrow();
  });
});
