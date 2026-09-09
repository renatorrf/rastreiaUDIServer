import { describe, expect, it } from 'vitest';
import { customerPhoneMatches, customerPhoneStorageVariants, normalizeCustomerPhone } from './customer-phone.js';

describe('customer phone normalization', () => {
  it('normalizes Brazilian local and international formats to the same value', () => {
    expect(normalizeCustomerPhone('+55 (34) 99999-1234')).toBe('34999991234');
    expect(customerPhoneMatches('+55 (34) 99999-1234', '(34) 99999-1234')).toBe(true);
  });

  it('does not accept different recipients as the same customer', () => {
    expect(customerPhoneMatches('(34) 99999-1234', '(34) 99999-4321')).toBe(false);
  });

  it('recognizes a legacy mobile number without the ninth digit', () => {
    expect(normalizeCustomerPhone('(34) 9999-1234')).toBe('34999991234');
    expect(customerPhoneMatches('(34) 99999-1234', '(34) 9999-1234')).toBe(true);
    expect(customerPhoneStorageVariants('(34) 99999-1234')).toEqual([
      '34999991234', '5534999991234', '3499991234', '553499991234',
    ]);
  });

  it('does not insert a ninth digit into a landline', () => {
    expect(normalizeCustomerPhone('(34) 3232-1234')).toBe('3432321234');
    expect(customerPhoneMatches('(34) 3232-1234', '(34) 93232-1234')).toBe(false);
  });
});
