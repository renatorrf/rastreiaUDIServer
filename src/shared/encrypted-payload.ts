import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function key(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptPayload(value: unknown, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url')].join('.');
}

export function decryptPayload<T>(value: string, secret: string): T {
  const [version, encodedIv, encodedTag, encodedPayload] = value.split('.');
  if (version !== 'v1' || !encodedIv || !encodedTag || !encodedPayload) {
    throw new Error('ENCRYPTED_PAYLOAD_INVALID');
  }
  const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(encodedIv, 'base64url'));
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encodedPayload, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}
