export interface OperationalMetricSample {
  evaluated: number;
  onTime: number;
  late: number;
  pending: number;
  rate: number | null;
  averageDelayMinutes: number | null;
}

export interface OperationalRouteMetrics {
  started: number;
  completed: number;
  averageDurationMinutes: number | null;
  totalDurationHours: number;
}

export interface OperationalProductivityMetrics {
  delivered: number;
  activeCouriers: number;
  deliveriesPerCourier: number | null;
  deliveriesPerRouteHour: number | null;
}

export interface OperationalMetricSet {
  pickup: OperationalMetricSample;
  delivery: OperationalMetricSample;
  routes: OperationalRouteMetrics;
  productivity: OperationalProductivityMetrics;
}

export interface OperationalMetricDimension extends OperationalMetricSet {
  dimension: 'STORE' | 'COURIER';
  id: string;
  name: string;
}

export interface OperationalMetricsReport {
  scope: {
    from: string;
    to: string;
    generatedAt: string;
    storeId: string | null;
    courierId: string | null;
  };
  summary: OperationalMetricSet;
  dimensions: OperationalMetricDimension[];
  rules: Array<{
    key: string;
    label: string;
    definition: string;
    cohort: string;
  }>;
  separation: {
    operational: string;
    reputation: string;
  };
}

export interface OperationalMetricsFilter {
  from?: Date | undefined;
  to?: Date | undefined;
  storeId?: string | undefined;
  courierId?: string | undefined;
}
