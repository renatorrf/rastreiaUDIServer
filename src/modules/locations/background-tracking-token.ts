import { createHash, createHmac, randomBytes } from 'node:crypto';

export function generateBackgroundTrackingToken(): string {
  return randomBytes(32).toString('base64url');
}

export function backgroundTrackingTokenHash(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`background-tracking:${token}`).digest('hex');
}

export function nativeLocationEventId(
  sessionId: string,
  point: { latitude: number; longitude: number; accuracy: number; time: number },
): string {
  const canonical = [sessionId, Math.trunc(point.time), point.latitude, point.longitude, point.accuracy].join(':');
  const bytes = Buffer.from(createHash('sha256').update(canonical).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
