export type ExternalOrderAction = 'CONFIRM' | 'PREPARE' | 'DISPATCH' | 'CANCEL';
export interface ExternalEvent {
  id: string; merchantId: string; orderId: string; code: string; fullCode: string; createdAt: string;
}
export interface CancellationReason { cancellationCode: string; description: string }
/** No courier rules or delivery state machine belong in a provider. */
export interface ExternalOrderProvider {
  getOrder(orderId: string): Promise<unknown>;
  getMerchant(merchantId: string): Promise<{ id: string; name: string }>;
  pollEvents(merchantIds: string[]): Promise<ExternalEvent[]>;
  acknowledge(ids: string[]): Promise<void>;
  confirmOrder(orderId: string): Promise<void>;
  startPreparation(orderId: string): Promise<void>;
  dispatchOrder(orderId: string): Promise<void>;
  getCancellationReasons(orderId: string): Promise<CancellationReason[]>;
  requestCancellation(orderId: string, reason: CancellationReason): Promise<void>;
}
