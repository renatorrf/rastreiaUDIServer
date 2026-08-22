export interface AddressSuggestion {
  providerId: string;
  formatted: string;
  addressLine: string;
  addressNumber: string | null;
  neighborhood: string | null;
  city: string;
  state: string;
  postalCode: string | null;
  latitude: number;
  longitude: number;
  confidence: number | null;
}

export interface AddressAutocompleteInput {
  query: string;
  latitude?: number;
  longitude?: number;
  city?: string;
}

export interface GeocodingProvider {
  autocomplete(input: AddressAutocompleteInput): Promise<AddressSuggestion[]>;
}

export interface MapTilesProvider {
  getPublicStyleUrl(): string | null;
  getPublicRasterTileUrl?(): string | null;
}

export interface RouteMatrixLocation {
  latitude: number;
  longitude: number;
}

export interface RouteMatrixCell {
  distanceM: number;
  durationS: number;
}

export interface RouteMatrixResult {
  provider: 'GEOAPIFY' | 'HAVERSINE';
  cells: RouteMatrixCell[][];
}

export interface RouteMatrixProvider {
  calculate(locations: RouteMatrixLocation[], mode: string): Promise<RouteMatrixResult>;
}

export interface RouteGeometry {
  type: 'LineString' | 'MultiLineString';
  coordinates: number[][] | number[][][];
}

export interface RouteInstruction {
  text: string;
  type: string | null;
  distanceM: number;
  durationS: number;
}

export interface RouteDirectionsResult {
  provider: 'GEOAPIFY';
  distanceM: number;
  durationS: number;
  geometry: RouteGeometry;
  instructions: RouteInstruction[];
}

export interface RouteDirectionsProvider {
  calculateRoute(
    origin: RouteMatrixLocation,
    destination: RouteMatrixLocation,
    mode: string,
  ): Promise<RouteDirectionsResult>;
}
