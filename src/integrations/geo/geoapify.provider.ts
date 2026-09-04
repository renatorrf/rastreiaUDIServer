import type {
  AddressAutocompleteInput, AddressSuggestion, GeocodingProvider, MapTilesProvider,
  RouteDirectionsProvider, RouteDirectionsResult, RouteGeometry, RouteMatrixLocation,
  RouteMatrixProvider, RouteMatrixResult,
} from './geo-provider.js';
import { toGeoapifyWaypoint } from './geo-point.js';

interface GeoapifyFeature {
  properties?: {
    place_id?: string;
    formatted?: string;
    address_line1?: string;
    street?: string;
    housenumber?: string;
    suburb?: string;
    district?: string;
    city?: string;
    county?: string;
    state_code?: string;
    state?: string;
    iso3166_2?: string;
    plus_code_short?: string;
    postcode?: string;
    lat?: number;
    lon?: number;
    country_code?: string;
    result_type?: string;
    rank?: { confidence?: number };
  };
}

const BRAZIL_STATE_NAMES: Record<string, string> = {
  acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE',
  'distrito federal': 'DF', 'espirito santo': 'ES', goias: 'GO', maranhao: 'MA',
  'mato grosso': 'MT', 'mato grosso do sul': 'MS', 'minas gerais': 'MG', para: 'PA',
  paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI', 'rio de janeiro': 'RJ',
  'rio grande do norte': 'RN', 'rio grande do sul': 'RS', rondonia: 'RO', roraima: 'RR',
  'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE', tocantins: 'TO',
};
const BRAZIL_STATE_CODES = new Set(Object.values(BRAZIL_STATE_NAMES));

function normalizeAddressPart(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
}

function resolveBrazilState(item: NonNullable<GeoapifyFeature['properties']>): string {
  const explicitCodes = [item.state_code, item.iso3166_2?.split('-').at(-1)];
  for (const candidate of explicitCodes) {
    const code = candidate?.toUpperCase();
    if (code && BRAZIL_STATE_CODES.has(code)) return code;
  }
  const context = normalizeAddressPart([item.state, item.plus_code_short, item.formatted].filter(Boolean).join(' '));
  const match = Object.entries(BRAZIL_STATE_NAMES)
    .sort(([first], [second]) => second.length - first.length)
    .find(([name]) => context.includes(name));
  return match?.[1] ?? '';
}

export class GeoapifyProvider implements GeocodingProvider, MapTilesProvider, RouteMatrixProvider, RouteDirectionsProvider {
  constructor(private readonly apiKey: string) {}

  getPublicStyleUrl(): string | null {
    if (!this.apiKey) return null;
    return `https://maps.geoapify.com/v1/styles/osm-bright/style.json?apiKey=${encodeURIComponent(this.apiKey)}`;
  }

  getPublicRasterTileUrl(): string | null {
    if (!this.apiKey) return null;
    return `https://maps.geoapify.com/v1/tile/dark-matter/{z}/{x}/{y}.png?apiKey=${encodeURIComponent(this.apiKey)}`;
  }

  async autocomplete(input: AddressAutocompleteInput): Promise<AddressSuggestion[]> {
    if (!this.apiKey) throw new Error('GEOAPIFY_NOT_CONFIGURED');

    const url = new URL('https://api.geoapify.com/v1/geocode/autocomplete');
    const normalizedQuery = normalizeAddressPart(input.query);
    const normalizedCity = input.city ? normalizeAddressPart(input.city) : undefined;
    const text = input.city && normalizedCity && !normalizedQuery.includes(normalizedCity)
      ? `${input.query}, ${input.city}`
      : input.query;
    url.searchParams.set('text', text);
    url.searchParams.set('lang', 'pt');
    url.searchParams.set('limit', '6');
    url.searchParams.set('filter', 'countrycode:br');
    if (input.latitude !== undefined && input.longitude !== undefined) {
      url.searchParams.set('bias', `proximity:${input.longitude},${input.latitude}`);
    }
    url.searchParams.set('apiKey', this.apiKey);

    const response = await fetch(url, { headers: { accept: 'application/geo+json' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`GEOAPIFY_HTTP_${response.status}`);
    const payload = (await response.json()) as { features?: GeoapifyFeature[] };

    return (payload.features ?? []).flatMap((feature) => {
      const item = feature.properties;
      if (!item?.place_id || item.lat === undefined || item.lon === undefined || !item.formatted) return [];
      return [{
        providerId: item.place_id,
        formatted: item.formatted,
        addressLine: item.street ?? item.address_line1 ?? item.formatted,
        addressNumber: item.housenumber ?? null,
        neighborhood: item.suburb ?? item.district ?? null,
        city: item.city ?? item.county ?? '',
        state: resolveBrazilState(item),
        postalCode: item.postcode ?? null,
        latitude: item.lat,
        longitude: item.lon,
        confidence: item.rank?.confidence ?? null,
        countryCode: item.country_code ?? null,
        resultType: item.result_type ?? null,
      }];
    });
  }

  async calculate(locations: RouteMatrixLocation[], mode: string): Promise<RouteMatrixResult> {
    if (!this.apiKey) throw new Error('GEOAPIFY_NOT_CONFIGURED');
    if (locations.length < 2 || locations.length * locations.length > 1000) throw new Error('ROUTE_MATRIX_LIMIT');
    const url = new URL('https://api.geoapify.com/v1/routematrix');
    url.searchParams.set('apiKey', this.apiKey);
    const points = locations.map((point) => ({ location: [point.longitude, point.latitude] }));
    const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json',
      'content-type': 'application/json' }, body: JSON.stringify({ mode, sources: points, targets: points,
      traffic: 'approximated', type: 'balanced' }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`GEOAPIFY_MATRIX_HTTP_${response.status}`);
    const payload = await response.json() as { sources_to_targets?: Array<Array<{ distance?: number; time?: number }>> };
    if (!payload.sources_to_targets || payload.sources_to_targets.length !== locations.length) {
      throw new Error('GEOAPIFY_MATRIX_INVALID');
    }
    return { provider: 'GEOAPIFY', cells: payload.sources_to_targets.map((row) => row.map((cell) => ({
      distanceM: Math.max(0, Math.round(cell.distance ?? 0)), durationS: Math.max(0, Math.round(cell.time ?? 0)),
    }))) };
  }

  async calculateRoute(
    origin: RouteMatrixLocation, destination: RouteMatrixLocation, mode: string,
  ): Promise<RouteDirectionsResult> {
    if (!this.apiKey) throw new Error('GEOAPIFY_NOT_CONFIGURED');
    const url = new URL('https://api.geoapify.com/v1/routing');
    url.searchParams.set('waypoints', `${toGeoapifyWaypoint(origin)}|${toGeoapifyWaypoint(destination)}`);
    url.searchParams.set('mode', mode);
    url.searchParams.set('lang', 'pt-BR');
    url.searchParams.set('details', 'instruction_details');
    url.searchParams.set('traffic', 'approximated');
    url.searchParams.set('type', 'balanced');
    url.searchParams.set('format', 'geojson');
    url.searchParams.set('apiKey', this.apiKey);
    const response = await fetch(url, {
      headers: { accept: 'application/geo+json' }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`GEOAPIFY_ROUTE_HTTP_${response.status}`);
    const payload = await response.json() as {
      features?: Array<{
        geometry?: RouteGeometry;
        properties?: {
          distance?: number; time?: number;
          legs?: Array<{ steps?: Array<{
            distance?: number; time?: number; instruction?: { text?: string; type?: string };
          }> }>;
        };
      }>;
    };
    const feature = payload.features?.[0];
    const geometry = feature?.geometry;
    const properties = feature?.properties;
    if (!geometry || !['LineString', 'MultiLineString'].includes(geometry.type)
      || !Array.isArray(geometry.coordinates) || !geometry.coordinates.length || !properties) {
      throw new Error('GEOAPIFY_ROUTE_INVALID');
    }
    return {
      provider: 'GEOAPIFY',
      distanceM: Math.max(0, Math.round(properties.distance ?? 0)),
      durationS: Math.max(0, Math.round(properties.time ?? 0)),
      geometry,
      instructions: (properties.legs ?? []).flatMap((leg) => (leg.steps ?? []).flatMap((step) => {
        const text = step.instruction?.text?.trim();
        return text ? [{
          text, type: step.instruction?.type ?? null,
          distanceM: Math.max(0, Math.round(step.distance ?? 0)),
          durationS: Math.max(0, Math.round(step.time ?? 0)),
        }] : [];
      })),
    };
  }
}

export class HaversineRouteMatrixProvider implements RouteMatrixProvider {
  async calculate(locations: RouteMatrixLocation[], mode: string): Promise<RouteMatrixResult> {
    const speedKph = ({ bicycle: 18, motorcycle: 35, scooter: 30, light_truck: 28, drive: 32 } as Record<string, number>)[mode] ?? 30;
    const cells = locations.map((source) => locations.map((target) => {
      const lat1 = source.latitude * Math.PI / 180; const lat2 = target.latitude * Math.PI / 180;
      const deltaLat = (target.latitude - source.latitude) * Math.PI / 180;
      const deltaLon = (target.longitude - source.longitude) * Math.PI / 180;
      const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
      const straightM = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distanceM = Math.round(straightM * 1.25);
      return { distanceM, durationS: Math.round(distanceM / (speedKph * 1000 / 3600)) };
    }));
    return { provider: 'HAVERSINE', cells };
  }
}
