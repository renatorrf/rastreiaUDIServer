import { randomBytes } from 'node:crypto';

export function generateMasterPassword(): string {
  // 256 bits de entropia, sem caracteres que precisem de escape no dotenv.
  return randomBytes(32).toString('base64url');
}

export function updateMasterPasswordEnv(contents: string, password: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(password)) {
    throw new Error('Use uma senha criada pelo gerador seguro.');
  }
  const assignment = `BOOTSTRAP_PLATFORM_ADMIN_PASSWORD=${password}`;
  const key = /^[\t ]*(?:export[\t ]+)?BOOTSTRAP_PLATFORM_ADMIN_PASSWORD[\t ]*=[^\r\n]*/gm;
  const matches = [...contents.matchAll(key)];
  if (matches.length > 1) {
    throw new Error('Há mais de uma BOOTSTRAP_PLATFORM_ADMIN_PASSWORD no .env; remova a duplicidade.');
  }
  if (matches.length === 1) return contents.replace(key, assignment);
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  return `${contents}${contents && !contents.endsWith('\n') ? newline : ''}${assignment}${newline}`;
}
