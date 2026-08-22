import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeoapifyProvider } from '../src/integrations/geo/geoapify.provider.js';

afterEach(() => vi.unstubAllGlobals());

describe('Geoapify address autocomplete', () => {
  it('mantém o filtro compatível e incorpora a cidade ao texto pesquisado', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ features: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new GeoapifyProvider('test-key').autocomplete({
      query: 'Avenida Rondon Pacheco 1000', city: 'Uberlândia', latitude: -18.91, longitude: -48.28,
    });

    const requestUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(requestUrl.searchParams.get('text')).toBe('Avenida Rondon Pacheco 1000, Uberlândia');
    expect(requestUrl.searchParams.get('filter')).toBe('countrycode:br');
    expect(requestUrl.searchParams.get('bias')).toBe('proximity:-48.28,-18.91');
  });

  it('separa logradouro e número na sugestão retornada', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ features: [{ properties: {
      place_id: 'address-id', formatted: 'Avenida Rondon Pacheco 1000, Uberlândia - MG',
      address_line1: 'Avenida Rondon Pacheco 1000', street: 'Avenida Rondon Pacheco', housenumber: '1000',
      city: 'Uberlândia', state: 'Sudeste', plus_code_short: '4P4X+F4 Uberlândia, Minas Gerais, Brasil',
      postcode: '38408-404', lat: -18.91, lon: -48.28,
      rank: { confidence: 0.98 },
    } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const suggestions = await new GeoapifyProvider('test-key').autocomplete({ query: 'Rondon Pacheco 1000' });

    expect(suggestions[0]).toMatchObject({
      addressLine: 'Avenida Rondon Pacheco', addressNumber: '1000', city: 'Uberlândia', state: 'MG',
    });
  });
});
