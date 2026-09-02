import { describe, expect, it } from 'vitest';
import { generateMasterPassword, updateMasterPasswordEnv } from '../src/security/master-password.js';

describe('senha segura do Master', () => {
  it('gera 32 bytes aleatórios no formato seguro para dotenv', () => {
    const password = generateMasterPassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(password, 'base64url')).toHaveLength(32);
    expect(generateMasterPassword()).not.toBe(password);
  });

  it('preserva as demais configurações, comentários e CRLF', () => {
    const password = generateMasterPassword();
    const contents = '# configuração\r\nDATABASE_URL=private\r\nBOOTSTRAP_PLATFORM_ADMIN_PASSWORD=old\r\nSMTP_PASSWORD=other\r\n';
    expect(updateMasterPasswordEnv(contents, password)).toBe(contents.replace('PASSWORD=old', `PASSWORD=${password}`));
  });

  it('aceita export e espaços no campo existente', () => {
    const password = generateMasterPassword();
    expect(updateMasterPasswordEnv(' export BOOTSTRAP_PLATFORM_ADMIN_PASSWORD = "old"\n', password))
      .toBe(`BOOTSTRAP_PLATFORM_ADMIN_PASSWORD=${password}\n`);
  });

  it('adiciona a chave ausente sem ativar a linha comentada', () => {
    const password = generateMasterPassword();
    const contents = '# BOOTSTRAP_PLATFORM_ADMIN_PASSWORD=example\nOTHER=value';
    expect(updateMasterPasswordEnv(contents, password)).toBe(`${contents}\nBOOTSTRAP_PLATFORM_ADMIN_PASSWORD=${password}\n`);
  });

  it('rejeita chaves duplicadas antes de gravar', () => {
    expect(() => updateMasterPasswordEnv('BOOTSTRAP_PLATFORM_ADMIN_PASSWORD=a\nBOOTSTRAP_PLATFORM_ADMIN_PASSWORD=b', generateMasterPassword()))
      .toThrow('duplicidade');
  });

  it('rejeita quebras de linha ou valores fora do formato do gerador', () => {
    expect(() => updateMasterPasswordEnv('', 'unsafe\nOTHER=value')).toThrow();
  });
});
