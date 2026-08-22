import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { AppError } from '../../shared/errors.js';
import { authenticate } from '../../modules/auth/auth.guard.js';
import type { GeocodingProvider, MapTilesProvider } from './geo-provider.js';

const autocompleteSchema = z.object({
  q: z.string().trim().min(3).max(200),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  city: z.string().trim().max(120).optional(),
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

  app.get('/geo/autocomplete', { preHandler: auth }, async (request) => {
    const input = autocompleteSchema.parse(request.query);
    try {
      return { data: await geocoding.autocomplete({
        query: input.q,
        ...(input.latitude === undefined ? {} : { latitude: input.latitude }),
        ...(input.longitude === undefined ? {} : { longitude: input.longitude }),
        ...(input.city === undefined ? {} : { city: input.city }),
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
