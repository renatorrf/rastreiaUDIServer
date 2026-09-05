export function normalizeCustomerPhone(value: string): string {
  let digits = value.replace(/\D/g, '');
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) digits = digits.slice(2);
  return digits;
}

export function customerPhoneMatches(left: string, right: string): boolean {
  return normalizeCustomerPhone(left) === normalizeCustomerPhone(right);
}
