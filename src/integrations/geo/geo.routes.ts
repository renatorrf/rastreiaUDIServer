import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { withPlatformTransaction, type Database } from '../../database/pool.js';
import { AppError } from '../../shared/errors.js';
import { authenticate, authenticatePlatform } from '../../modules/auth/auth.guard.js';
import type { GeocodingProvider, MapTilesProvider } from './geo-provider.js';

const autocompleteSchema = z.object({
  q: z.string().trim().min(3).max(200),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  city: z.string().trim().max(120).optional(),
  companyId:z.string().uuid().optional(),
});

export async function geoRoutes(
  app: FastifyInstance,
  env: AppEnv,
  database: Database,
  geocoding: GeocodingProvider,
  mapTiles: MapTilesProvider,
): Promise<void> {
  const auth = authenticate(env, database);
  const publicMapConfig = () => {
    const styleUrl = mapTiles.getPublicStyleUrl();
    const tileUrl = mapTiles.getPublicRasterTileUrl?.() ?? null;
    return {
      configured: styleUrl !== null || tileUrl !== null,
      styleUrl,
      tileUrl,
      attribution: 'Powered by Geoapify · © OpenMapTiles · © OpenStreetMap contributors',
    };
  };

  app.get('/maps/config', { preHandler: auth }, async () => publicMapConfig());
  app.get('/public/maps/config', async () => publicMapConfig());

  for(const [path,guard] of [['/geo/autocomplete',auth],['/platform/geo/autocomplete',authenticatePlatform(env,database)]] as const){
  app.get(path, { preHandler: guard, config:{rateLimit:{max:60,timeWindow:'1 minute'}} }, async (request,reply) => {
    reply.header('Cache-Control','no-store');
    const input = autocompleteSchema.parse(request.query);
    try {
      const reference=path==='/platform/geo/autocomplete'&&input.companyId?await withPlatformTransaction(database,request.platformAuth,async client=>
        (await client.query<{city:string;state:string;latitude:number;longitude:number}>(`SELECT store.city,store.state,store.latitude,store.longitude FROM stores store
          JOIN companies company ON company.id=store.company_id JOIN tenants tenant ON tenant.id=store.tenant_id
          WHERE store.company_id=$1 AND store.status='ACTIVE' AND company.status='ACTIVE' AND tenant.status='ACTIVE'
          ORDER BY store.created_at,store.id LIMIT 1`,[input.companyId])).rows[0]):undefined;
      const city=input.city|| (reference?`${reference.city}, ${reference.state}`:undefined);
      const useReference=!input.city&&input.latitude===undefined&&input.longitude===undefined&&reference;
      return { data: await geocoding.autocomplete({
        query: input.q,
        ...(input.latitude === undefined ? {} : { latitude: input.latitude }),
        ...(input.longitude === undefined ? {} : { longitude: input.longitude }),
        ...(city === undefined ? {} : { city }),
        ...(useReference?{latitude:useReference.latitude,longitude:useReference.longitude}:{}),
      }) };
    } catch (error) {
      if ((error as Error).message === 'GEOAPIFY_NOT_CONFIGURED') {
        throw new AppError(503, 'GEOAPIFY_NOT_CONFIGURED', 'Autocomplete ainda não foi configurado.');
      }
      request.log.warn({ err: error }, 'Falha ao consultar provedor de geocoding');
      throw new AppError(502, 'GEOCODING_UNAVAILABLE', 'Serviço de endereços temporariamente indisponível.');
    }
  });
  }
}
