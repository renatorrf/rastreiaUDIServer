import { describe, expect, it } from 'vitest';
import { parseEnv } from 'node:util';
import { prepareProductionSecrets } from './production-secrets.js';

const fixture = () => [
  '# Preserve comments', `JWT_ACCESS_SECRET=${'a'.repeat(40)}`, `JWT_REFRESH_SECRET=${'b'.repeat(40)}`,
  `TRACKING_TOKEN_PEPPER=${'a'.repeat(40)}`, `MESSAGE_PAYLOAD_SECRET=${'c'.repeat(40)}`,
  'JWT_ACCESS_SECRET_PREVIOUS=', 'METRICS_BEARER_TOKEN=', 'NODE_ENV=development', 'DATABASE_URL=unchanged',
  'PUSH_VAPID_PRIVATE_KEY=preserved', 'MASTER_ACCESS_TOKEN=preserved', '',
].join('\r\n');

describe('private production secret preparation', () => {
  it('creates unique random secrets and preserves old access tokens, all protected keys and settings', () => {
    const original = fixture(); const result = prepareProductionSecrets(original);
    const before = parseEnv(original); const after = parseEnv(result.contents);
    expect(after.JWT_ACCESS_SECRET).toMatch(/^[\w-]{64}$/);
    expect(after.METRICS_BEARER_TOKEN).toMatch(/^[\w-]{64}$/);
    expect(after.JWT_ACCESS_SECRET).not.toBe(after.METRICS_BEARER_TOKEN);
    expect(after.JWT_ACCESS_SECRET_PREVIOUS).toBe(before.JWT_ACCESS_SECRET);
    for (const key of Object.keys(before).filter(key => !result.changed.includes(key))) expect(after[key]).toBe(before[key]);
    expect(result.contents).toContain('# Preserve comments\r\n');
    expect(prepareProductionSecrets(result.contents).changed).toEqual([]);
  });
  it('does not generate the same credentials on independent runs', () => {
    expect(parseEnv(prepareProductionSecrets(fixture()).contents).JWT_ACCESS_SECRET)
      .not.toBe(parseEnv(prepareProductionSecrets(fixture()).contents).JWT_ACCESS_SECRET);
  });
  it('rejects duplicate assignments and active incompatible rotations', () => {
    expect(() => prepareProductionSecrets(fixture() + 'METRICS_BEARER_TOKEN=other')).toThrow();
    expect(() => prepareProductionSecrets(fixture().replace('JWT_ACCESS_SECRET_PREVIOUS=', `JWT_ACCESS_SECRET_PREVIOUS=${'z'.repeat(40)}`))).toThrow();
  });
  it('never creates or replaces a missing data encryption key or colliding protected keys', () => {
    expect(() => prepareProductionSecrets(fixture().replace('c'.repeat(40), ''))).toThrow();
    expect(() => prepareProductionSecrets(fixture().replace('c'.repeat(40), 'b'.repeat(40)))).toThrow();
  });
  it('rejects ambiguous multiline access secrets', () => {
    const input = fixture().replace('JWT_ACCESS_SECRET=' + 'a'.repeat(40), `JWT_ACCESS_SECRET="${'a'.repeat(40)}\nmore"`)
      .replace('TRACKING_TOKEN_PEPPER=' + 'a'.repeat(40), `TRACKING_TOKEN_PEPPER="${'a'.repeat(40)}\nmore"`);
    expect(() => prepareProductionSecrets(input)).toThrow();
  });
});
