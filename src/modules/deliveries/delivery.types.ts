export const deliveryStatuses = [
  'DRAFT', 'AWAITING_COURIER', 'ASSIGNED', 'AWAITING_PICKUP', 'COLLECTED',
  'IN_ROUTE', 'NEXT_STOP', 'DELIVERED', 'CANCELLED', 'DELIVERY_FAILED',
  'RETURN_STARTED', 'RETURNED',
] as const;

export type DeliveryStatus = (typeof deliveryStatuses)[number];

export interface DeliveryRecord {
  id: string;
  tenantId: string;
  storeId: string;
  storeName: string;
  routeId: string | null;
  courierId: string | null;
  courierName: string | null;
  externalReference: string | null;
  origin?: string;
  externalOrderId?: string | null;
  recipientName: string;
  recipientPhone: string;
  recipientWhatsapp: string | null;
  addressLine: string;
  addressNumber: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string;
  state: string;
  postalCode: string | null;
  latitude: number;
  longitude: number;
  addressConfidence: number | null;
  deliveryInstructions: string | null;
  status: DeliveryStatus;
  promisedWindowStart: Date | null;
  promisedWindowEnd: Date | null;
  collectedAt: Date | null;
  outForDeliveryAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
