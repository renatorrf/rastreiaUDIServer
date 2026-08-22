import { conflict } from '../../shared/errors.js';
import type { DeliveryStatus } from './delivery.types.js';

const allowedTransitions: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  DRAFT: ['AWAITING_COURIER', 'CANCELLED'],
  AWAITING_COURIER: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['AWAITING_PICKUP', 'CANCELLED'],
  AWAITING_PICKUP: ['COLLECTED', 'DELIVERY_FAILED', 'CANCELLED'],
  COLLECTED: ['IN_ROUTE', 'DELIVERY_FAILED', 'CANCELLED'],
  IN_ROUTE: ['NEXT_STOP', 'DELIVERED', 'DELIVERY_FAILED', 'CANCELLED'],
  NEXT_STOP: ['DELIVERED', 'DELIVERY_FAILED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
  DELIVERY_FAILED: ['RETURN_STARTED'],
  RETURN_STARTED: ['RETURNED'],
  RETURNED: [],
};

export function assertDeliveryTransition(from: DeliveryStatus, to: DeliveryStatus): void {
  if (!allowedTransitions[from].includes(to)) {
    throw conflict(`Transição de ${from} para ${to} não é permitida.`);
  }
}

export function nextOperationalActions(status: DeliveryStatus): string[] {
  switch (status) {
    case 'AWAITING_COURIER': return ['assign', 'cancel'];
    case 'AWAITING_PICKUP': return ['collect', 'fail', 'cancel'];
    case 'COLLECTED': return ['start', 'fail', 'cancel'];
    case 'IN_ROUTE':
    case 'NEXT_STOP': return ['complete', 'fail', 'cancel'];
    default: return [];
  }
}
