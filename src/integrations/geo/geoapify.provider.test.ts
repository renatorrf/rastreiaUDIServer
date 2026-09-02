import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeoapifyProvider } from './geoapify.provider.js';
afterEach(()=>vi.unstubAllGlobals());
describe('Geoapify address normalization',()=>{
  it('preserves house number in the full query and maps the provider house number',async()=>{
    const request=vi.fn().mockResolvedValue({ok:true,json:async()=>({features:[{properties:{place_id:'test',formatted:'Avenida Brasil, 2662, Uberlândia, MG',street:'Avenida Brasil',housenumber:'2662',city:'Uberlândia',state_code:'MG',suburb:'Centro',postcode:'38400000',lat:-18.9,lon:-48.2,rank:{confidence:0.95}}}]})});vi.stubGlobal('fetch',request);
    const rows=await new GeoapifyProvider('synthetic-only').autocomplete({query:'Avenida Brasil, 2662',city:'Uberlândia, MG',latitude:-18.9,longitude:-48.2});
    const url=request.mock.calls[0]![0] as URL;expect(url.searchParams.get('text')).toBe('Avenida Brasil, 2662, Uberlândia, MG');expect(url.searchParams.get('bias')).toBe('proximity:-48.2,-18.9');
    expect(rows[0]).toMatchObject({addressLine:'Avenida Brasil',addressNumber:'2662',city:'Uberlândia',state:'MG',neighborhood:'Centro',postalCode:'38400000',latitude:-18.9,longitude:-48.2,confidence:0.95});
  });
  it('does not invent a house number if the provider only finds the street',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({features:[{properties:{place_id:'test',formatted:'Avenida Brasil',street:'Avenida Brasil',city:'Uberlândia',state:'Minas Gerais',lat:-18.9,lon:-48.2}}]})}));
    expect((await new GeoapifyProvider('synthetic-only').autocomplete({query:'Avenida Brasil, 2662'}))[0]?.addressNumber).toBeNull();
  });
});
