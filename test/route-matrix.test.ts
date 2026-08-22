import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeoapifyProvider, HaversineRouteMatrixProvider } from '../src/integrations/geo/geoapify.provider.js';

afterEach(() => vi.unstubAllGlobals());

describe('route matrix providers', () => {
  it('envia coordenadas Geoapify em longitude/latitude e normaliza a matriz', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sources_to_targets: [
      [{ distance: 0, time: 0 }, { distance: 1250.4, time: 301.7 }],
      [{ distance: 1300, time: 320 }, { distance: 0, time: 0 }],
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new GeoapifyProvider('test-key').calculate([
      { latitude: -23.55, longitude: -46.63 }, { latitude: -23.56, longitude: -46.64 },
    ], 'motorcycle');
    const request = fetchMock.mock.calls[0] as [URL, RequestInit];
    const requestBody = request[1].body;
    expect(typeof requestBody).toBe('string');
    const payload = JSON.parse(requestBody as string) as { mode: string; sources: Array<{ location: number[] }> };
    expect(payload.mode).toBe('motorcycle');
    expect(payload.sources[0]?.location).toEqual([-46.63, -23.55]);
    expect(result.provider).toBe('GEOAPIFY');
    expect(result.cells[0]?.[1]).toEqual({ distanceM: 1250, durationS: 302 });
  });

  it('produz contingência determinística sem chamada externa', async () => {
    const result = await new HaversineRouteMatrixProvider().calculate([
      { latitude: -23.55, longitude: -46.63 }, { latitude: -23.56, longitude: -46.64 },
    ], 'motorcycle');
    expect(result.provider).toBe('HAVERSINE');
    expect(result.cells[0]?.[0]).toEqual({ distanceM: 0, durationS: 0 });
    expect(result.cells[0]?.[1]?.distanceM).toBeGreaterThan(1000);
    expect(result.cells[0]?.[1]?.durationS).toBeGreaterThan(0);
  });
});
