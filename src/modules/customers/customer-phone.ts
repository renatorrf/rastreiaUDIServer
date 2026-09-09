export function normalizeCustomerPhone(value: string): string {
  let digits = value.replace(/\D/g, '');
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) digits = digits.slice(2);
  // Brazilian mobile numbers stored before the ninth-digit migration may still
  // contain DDD + 8 digits. Canonicalize them without changing landlines.
  if (digits.length === 10 && /^[1-9]{2}[6-9]/.test(digits)) {
    digits = `${digits.slice(0, 2)}9${digits.slice(2)}`;
  }
  return digits;
}

export function customerPhoneMatches(left: string, right: string): boolean {
  return normalizeCustomerPhone(left) === normalizeCustomerPhone(right);
}

export function customerPhoneStorageVariants(value: string): string[] {
  const canonical = normalizeCustomerPhone(value);
  const local = [canonical];
  if (canonical.length === 11 && canonical[2] === '9') {
    local.push(`${canonical.slice(0, 2)}${canonical.slice(3)}`);
  }
  return [...new Set(local.flatMap((phone) => [phone, `55${phone}`]))];
}
