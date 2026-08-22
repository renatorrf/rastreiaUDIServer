import type { TenantRole } from '../auth/auth.types.js';

export type DisputeStatus = 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED';
export type DisputeCategory = 'SERVICE' | 'PUNCTUALITY' | 'PAYMENT' | 'CANCELLATION' | 'CONDUCT' | 'OTHER';
export type DisputeOutcome = 'STORE_FAVORED' | 'COURIER_FAVORED' | 'NO_FAULT' | 'AGREEMENT' | 'DISMISSED';

export interface DisputeEvidenceView {
  id: string;
  evidenceType: 'NOTE' | 'URL';
  content: string;
  submittedByName: string | null;
  submittedByRole: TenantRole;
  createdAt: string;
}

export interface DisputeEventView {
  id: string;
  eventType: string;
  actorName: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OfferDisputeView {
  id: string;
  offerId: string;
  storeId: string;
  storeName: string;
  courierId: string;
  courierName: string;
  deliveryReference: string | null;
  status: DisputeStatus;
  category: DisputeCategory;
  description: string;
  openedByName: string | null;
  openedByRole: TenantRole;
  responseDueAt: string;
  reviewStartedAt: string | null;
  outcome: DisputeOutcome | null;
  resolutionNotes: string | null;
  resolvedAt: string | null;
  evidence: DisputeEvidenceView[];
  events: DisputeEventView[];
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceBlockView {
  id: string;
  storeId: string | null;
  storeName: string | null;
  reason: string;
  activeUntil: string | null;
  createdAt: string;
}

export interface CourierReputationView {
  courierId: string;
  courierName: string;
  storeIds: string[];
  eligibleStoreIds: string[];
  eligible: boolean;
  eligibilityReasons: string[];
  notifiedCount: number;
  acceptedCount: number;
  completedCount: number;
  courierCancelledCount: number;
  onTimeCount: number;
  punctualitySampleCount: number;
  acceptanceRate: number | null;
  completionRate: number | null;
  cancellationRate: number | null;
  punctualityRate: number | null;
  activeBlocks: MarketplaceBlockView[];
  thresholds: { minimumSample: number; completionRate: number; punctualityRate: number };
}
