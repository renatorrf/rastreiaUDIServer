import { describe, expect, it } from 'vitest';
import { assertDeliveryTransition, nextOperationalActions } from '../src/modules/deliveries/delivery-state.js';

describe('delivery state machine', () => {
  it('permite o fluxo operacional crítico', () => {
    expect(() => assertDeliveryTransition('AWAITING_COURIER', 'ASSIGNED')).not.toThrow();
    expect(() => assertDeliveryTransition('ASSIGNED', 'AWAITING_PICKUP')).not.toThrow();
    expect(() => assertDeliveryTransition('AWAITING_PICKUP', 'COLLECTED')).not.toThrow();
    expect(() => assertDeliveryTransition('COLLECTED', 'IN_ROUTE')).not.toThrow();
    expect(() => assertDeliveryTransition('IN_ROUTE', 'DELIVERED')).not.toThrow();
  });

  it('bloqueia saltos e estados terminais', () => {
    expect(() => assertDeliveryTransition('AWAITING_COURIER', 'DELIVERED')).toThrow(/não é permitida/);
    expect(() => assertDeliveryTransition('DELIVERED', 'IN_ROUTE')).toThrow(/não é permitida/);
  });

  it('permite a devolução somente depois de uma falha de entrega', () => {
    expect(() => assertDeliveryTransition('DELIVERY_FAILED', 'RETURN_STARTED')).not.toThrow();
    expect(() => assertDeliveryTransition('RETURN_STARTED', 'RETURNED')).not.toThrow();
    expect(() => assertDeliveryTransition('IN_ROUTE', 'RETURN_STARTED')).toThrow(/não é permitida/);
  });

  it('expõe somente as próximas ações aplicáveis', () => {
    expect(nextOperationalActions('COLLECTED')).toEqual(['start', 'fail', 'cancel']);
    expect(nextOperationalActions('DELIVERED')).toEqual([]);
  });
});
