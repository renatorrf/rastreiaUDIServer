export const shiftPositionStatuses = ['RESERVED', 'AVAILABLE', 'FILLED', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type ShiftPositionStatus = (typeof shiftPositionStatuses)[number];

export interface ShiftApplicationView {
  id: string;
  courierId: string;
  courierName: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
  createdAt: string;
}

export interface ShiftChangeRequestView {
  id: string;
  requestType: 'WITHDRAWAL' | 'SUBSTITUTION' | 'TRANSFER';
  requesterCourierId: string | null;
  requesterCourierName: string | null;
  suggestedCourierId: string | null;
  suggestedCourierName: string | null;
  status: string;
  reason: string;
  noticeMinutes: number;
  createdAt: string;
}

export interface ShiftPositionView {
  id: string;
  slotId: string;
  storeId: string;
  storeName: string;
  label: string;
  startsAt: string;
  endsAt: string;
  checkinOpensAt: string;
  checkinDeadlineAt: string;
  checkinRadiusM: number;
  searchRadiusM: number;
  compensationCents: number;
  currency: string;
  requirements: Record<string, unknown>;
  autoApproveSubstitutes: boolean;
  confirmationLeadMinutes: number;
  withdrawalNoticeMinutes: number;
  slotStatus: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  positionNumber: number;
  status: ShiftPositionStatus;
  holderCourierId: string | null;
  holderCourierName: string | null;
  assignedCourierId: string | null;
  assignedCourierName: string | null;
  checkinAt: string | null;
  checkinDistanceM: number | null;
  checkoutAt: string | null;
  myApplicationId: string | null;
  myApplicationStatus: string | null;
  searchId: string | null;
  searchStatus: 'SEARCHING' | 'FILLED' | 'EXHAUSTED' | 'CANCELLED' | null;
  searchWaveNumber: number | null;
  searchWaveRadiusM: number | null;
  searchClosesAt: string | null;
  searchCandidateCount: number;
  mySearchCandidateId: string | null;
  confirmationStatus: 'PENDING' | 'CONFIRMED' | 'DECLINED' | 'EXPIRED' | null;
  confirmationDueAt: string | null;
  pendingChangeRequestId: string | null;
  changeRequests: ShiftChangeRequestView[];
  applications: ShiftApplicationView[];
  nextAction: 'ACCEPT' | 'AWAIT_APPROVAL' | 'CONFIRM' | 'CHECK_IN' | 'CHECK_OUT' | null;
}

export interface CreateShiftSlotInput {
  storeId: string;
  label: string;
  startsAt: Date;
  endsAt: Date;
  headcount: number;
  holderCourierIds: string[];
  checkinOpenMinutes: number;
  checkinToleranceMinutes: number;
  checkinRadiusM: number;
  searchRadiusM: number;
  compensationCents: number;
  requirements: Record<string, unknown>;
  autoApproveSubstitutes: boolean;
  confirmationLeadMinutes: number;
  withdrawalNoticeMinutes: number;
}

export interface CheckinInput {
  latitude: number;
  longitude: number;
  accuracy: number;
}
