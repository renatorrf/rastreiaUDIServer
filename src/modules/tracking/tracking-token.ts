import { createHmac, randomBytes } from 'node:crypto';
import type { DeliveryStatus } from '../deliveries/delivery.types.js';

export function generateTrackingToken(): string {
  return randomBytes(32).toString('base64url');
}

export function trackingTokenHash(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(token).digest('hex');
}

export function abbreviateCourierName(name: string | null): string | null {
  if (!name) return null;
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0] ?? null;
  return `${parts[0]} ${(parts.at(-1)?.[0] ?? '').toUpperCase()}.`;
}

export function canRevealDestination(status: DeliveryStatus): boolean {
  return ['IN_ROUTE', 'NEXT_STOP', 'DELIVERED'].includes(status);
}
