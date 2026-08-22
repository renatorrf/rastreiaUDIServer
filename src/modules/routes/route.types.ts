export interface RouteStopView {
  id: string;
  deliveryId: string;
  deliveryReference: string | null;
  recipientName: string;
  stopType: 'PICKUP' | 'DELIVERY';
  sequence: number;
  status: 'PENDING' | 'COMPLETED' | 'SKIPPED';
  addressLine: string;
  addressNumber: string | null;
  neighborhood: string | null;
  city: string;
  promisedWindowEnd: string | null;
  deliveryStatus: string;
  completedAt: string | null;
  estimatedDistanceFromPreviousM: number | null;
  estimatedDurationFromPreviousS: number | null;
  estimatedArrivalAt: string | null;
}

export interface DeliveryRouteView {
  id: string;
  storeId: string;
  storeName: string;
  courierId: string;
  courierName: string;
  label: string;
  notes: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  plannedStartAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  suggestedStopIds: string[] | null;
  suggestionProvider: 'GEOAPIFY' | 'HAVERSINE' | null;
  suggestedCurrentDistanceM: number | null;
  suggestedTotalDistanceM: number | null;
  suggestedTotalDurationS: number | null;
  suggestedAt: string | null;
  planAppliedAt: string | null;
  estimatedTotalDistanceM: number | null;
  estimatedTotalDurationS: number | null;
  etaCalculatedAt: string | null;
  version: number;
  completedStops: number;
  totalStops: number;
  stops: RouteStopView[];
  createdAt: string;
  updatedAt: string;
}

export interface RouteNavigationView {
  routeId: string;
  stopId: string;
  stopType: 'PICKUP' | 'DELIVERY';
  mode: string;
  provider: 'GEOAPIFY';
  origin: {
    latitude: number;
    longitude: number;
    source: 'LIVE_LOCATION' | 'PREVIOUS_STOP' | 'STORE';
    capturedAt: string | null;
  };
  destination: {
    latitude: number;
    longitude: number;
    label: string;
    addressLine: string;
    addressNumber: string | null;
    neighborhood: string | null;
    city: string;
    state: string;
  };
  distanceM: number;
  durationS: number;
  geometry: {
    type: 'LineString' | 'MultiLineString';
    coordinates: number[][] | number[][][];
  };
  instructions: Array<{
    text: string;
    type: string | null;
    distanceM: number;
    durationS: number;
  }>;
  calculatedAt: string;
}
