import { describe, expect, it } from 'vitest';
import { customerPhoneMatches, normalizeCustomerPhone } from './customer-phone.js';

describe('customer phone normalization', () => {
  it('normalizes Brazilian local and international formats to the same value', () => {
    expect(normalizeCustomerPhone('+55 (34) 99999-1234')).toBe('34999991234');
    expect(customerPhoneMatches('+55 (34) 99999-1234', '(34) 99999-1234')).toBe(true);
  });

  it('does not accept different recipients as the same customer', () => {
    expect(customerPhoneMatches('(34) 99999-1234', '(34) 99999-4321')).toBe(false);
  });
});
