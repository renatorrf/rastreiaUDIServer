import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeoapifyProvider } from '../src/integrations/geo/geoapify.provider.js';

afterEach(() => vi.unstubAllGlobals());

describe('Geoapify route directions', () => {
  it('solicita percurso viário e normaliza geometria e instruções', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      features: [{
        geometry: { type: 'MultiLineString', coordinates: [[[-48.28, -18.91], [-48.27, -18.92]]] },
        properties: {
          distance: 1540.4, time: 284.7,
          legs: [{ steps: [{
            distance: 350.3, time: 65.6,
            instruction: { text: 'Vire à direita', type: 'Right' },
          }] }],
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/geo+json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GeoapifyProvider('test-key').calculateRoute(
      { latitude: -18.91, longitude: -48.28 },
      { latitude: -18.92, longitude: -48.27 },
      'motorcycle',
    );

    const requestUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(requestUrl.searchParams.get('waypoints')).toBe('-18.91,-48.28|-18.92,-48.27');
    expect(requestUrl.searchParams.get('mode')).toBe('motorcycle');
    expect(requestUrl.searchParams.get('details')).toBe('instruction_details');
    expect(result).toMatchObject({
      provider: 'GEOAPIFY', distanceM: 1540, durationS: 285,
      geometry: { type: 'MultiLineString' },
      instructions: [{ text: 'Vire à direita', type: 'Right', distanceM: 350, durationS: 66 }],
    });
  });

  it('rejeita resposta sem geometria navegável', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ features: [] }), { status: 200 })));
    await expect(new GeoapifyProvider('test-key').calculateRoute(
      { latitude: -18.91, longitude: -48.28 },
      { latitude: -18.92, longitude: -48.27 },
      'drive',
    )).rejects.toThrow('GEOAPIFY_ROUTE_INVALID');
  });
});
