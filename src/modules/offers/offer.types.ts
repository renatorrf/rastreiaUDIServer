export interface DeliveryOfferView {
  id: string;
  storeId: string;
  storeName: string;
  deliveryId: string | null;
  deliveryReference: string | null;
  recipientName: string | null;
  status: 'PUBLISHED' | 'ACCEPTED' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';
  payoutCents: number;
  currency: string;
  estimatedDistanceM: number;
  estimatedDurationMinutes: number;
  pickupWindowStart: string;
  pickupWindowEnd: string;
  deliveryWindowEnd: string | null;
  expiresAt: string;
  searchRadiusM: number;
  volumeType: 'DOCUMENT' | 'SMALL' | 'MEDIUM' | 'LARGE';
  approximateRegion: string;
  requirements: Record<string, unknown>;
  winnerCourierId: string | null;
  winnerCourierName: string | null;
  acceptedAt: string | null;
  cancellationReason: string | null;
  cancellationFeeCents: number;
  cancelledByRole: 'TENANT_MANAGER' | 'STORE_OPERATOR' | 'COURIER' | null;
  priceRevisions: Array<{
    id: string; previousPayoutCents: number; newPayoutCents: number; reason: string; createdAt: string;
  }>;
  candidateCount: number;
  myCandidateStatus: 'NOTIFIED' | 'ACCEPTED' | 'LOST' | 'EXPIRED' | null;
  distanceToPickupM: number | null;
  createdAt: string;
}

export interface OfferFinancialEntryView {
  id: string;
  offerId: string;
  storeId: string;
  storeName: string;
  courierId: string;
  courierName: string;
  entryType: 'COMPLETION' | 'CANCELLATION_COMPENSATION';
  storeCostCents: number | null;
  courierEarningCents: number;
  currency: string;
  description: string;
  occurredAt: string;
}

export interface CreateDeliveryOfferInput {
  deliveryId: string;
  payoutCents: number;
  estimatedDistanceM: number;
  estimatedDurationMinutes: number;
  pickupWindowStart: Date;
  pickupWindowEnd: Date;
  deliveryWindowEnd?: Date | null | undefined;
  expiresAt: Date;
  searchRadiusM: number;
  volumeType: 'DOCUMENT' | 'SMALL' | 'MEDIUM' | 'LARGE';
  approximateRegion?: string | undefined;
  requirements: Record<string, unknown>;
}
