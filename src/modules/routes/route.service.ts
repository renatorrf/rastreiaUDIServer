import type { PoolClient } from 'pg';
import type { Database } from '../../database/pool.js';
import { withTenantTransaction } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { AppError, conflict, forbidden, notFound } from '../../shared/errors.js';
import { withIdempotency, type IdempotentResult } from '../../shared/idempotency.js';
import type { AuthContext } from '../auth/auth.types.js';
import type {
  RouteDirectionsProvider, RouteDirectionsResult, RouteMatrixProvider, RouteMatrixResult,
} from '../../integrations/geo/geo-provider.js';
import { HaversineRouteMatrixProvider } from '../../integrations/geo/geoapify.provider.js';
import { completeOfferForDelivery } from '../offers/offer.service.js';
import type { DeliveryRouteView, RouteNavigationView, RouteStopView } from './route.types.js';

interface RouteBase {
  id: string; storeId: string; storeName: string; courierId: string; courierName: string;
  label: string; notes: string | null; status: DeliveryRouteView['status']; plannedStartAt: string | null;
  startedAt: string | null; completedAt: string | null; suggestedStopIds: string[] | null;
  suggestionProvider: 'GEOAPIFY' | 'HAVERSINE' | null; suggestedCurrentDistanceM: number | null;
  suggestedTotalDistanceM: number | null; suggestedTotalDurationS: number | null; suggestedAt: string | null;
  planAppliedAt: string | null; estimatedTotalDistanceM: number | null; estimatedTotalDurationS: number | null;
  etaCalculatedAt: string | null; version: number; createdAt: string; updatedAt: string;
}

const routeSelect = `
  SELECT route.id, route.store_id AS "storeId", store.name AS "storeName",
    route.courier_profile_id AS "courierId", courier_user.name AS "courierName",
    route.label, route.notes, route.status, route.planned_start_at AS "plannedStartAt",
    route.started_at AS "startedAt", route.completed_at AS "completedAt",
    route.suggested_stop_ids AS "suggestedStopIds", route.suggestion_provider AS "suggestionProvider",
    route.suggested_current_distance_m AS "suggestedCurrentDistanceM",
    route.suggested_total_distance_m AS "suggestedTotalDistanceM",
    route.suggested_total_duration_s AS "suggestedTotalDurationS", route.suggested_at AS "suggestedAt",
    route.plan_applied_at AS "planAppliedAt", route.estimated_total_distance_m AS "estimatedTotalDistanceM",
    route.estimated_total_duration_s AS "estimatedTotalDurationS", route.eta_calculated_at AS "etaCalculatedAt", route.version,
    route.created_at AS "createdAt", route.updated_at AS "updatedAt"
  FROM routes route JOIN stores store ON store.id = route.store_id
  JOIN courier_profiles courier ON courier.id = route.courier_profile_id
  JOIN users courier_user ON courier_user.id = courier.user_id`;

const routeAccess = `AND ($2::text = 'TENANT_MANAGER'
  OR ($2::text = 'STORE_OPERATOR' AND route.store_id = ANY($3::uuid[]))
  OR ($2::text = 'COURIER' AND courier.user_id = $4))`;
const routeListAccess = `AND ($1::text = 'TENANT_MANAGER'
  OR ($1::text = 'STORE_OPERATOR' AND route.store_id = ANY($2::uuid[]))
  OR ($1::text = 'COURIER' AND courier.user_id = $3))`;

function canUseStore(auth: AuthContext, storeId: string): boolean {
  return auth.role === 'TENANT_MANAGER' || (auth.role === 'STORE_OPERATOR' && auth.storeIds.includes(storeId));
}

async function hydrate(client: PoolClient, bases: RouteBase[]): Promise<DeliveryRouteView[]> {
  const raw = await client.query<RouteStopView & { routeId: string }>(
    `SELECT stop.id, stop.route_id AS "routeId", stop.delivery_id AS "deliveryId",
      delivery.external_reference AS "deliveryReference", delivery.recipient_name AS "recipientName",
      stop.stop_type AS "stopType", stop.sequence, stop.status,
      CASE WHEN stop.stop_type = 'PICKUP' THEN store.address_line ELSE delivery.address_line END AS "addressLine",
      CASE WHEN stop.stop_type = 'PICKUP' THEN store.address_number ELSE delivery.address_number END AS "addressNumber",
      CASE WHEN stop.stop_type = 'PICKUP' THEN store.neighborhood ELSE delivery.neighborhood END AS neighborhood,
      CASE WHEN stop.stop_type = 'PICKUP' THEN store.city ELSE delivery.city END AS city,
      delivery.promised_window_end AS "promisedWindowEnd", delivery.status AS "deliveryStatus",
      stop.completed_at AS "completedAt",
      stop.estimated_distance_from_previous_m AS "estimatedDistanceFromPreviousM",
      stop.estimated_duration_from_previous_s AS "estimatedDurationFromPreviousS",
      stop.estimated_arrival_at AS "estimatedArrivalAt"
     FROM route_stops stop JOIN deliveries delivery ON delivery.id = stop.delivery_id
     JOIN stores store ON store.id = delivery.store_id
     WHERE stop.route_id = ANY($1::uuid[]) ORDER BY stop.route_id, stop.sequence`, [bases.map((item) => item.id)],
  );
  return bases.map((base) => {
    const stops = raw.rows.filter((stop) => stop.routeId === base.id);
    return { ...base, stops, totalStops: stops.length,
      completedStops: stops.filter((stop) => stop.status === 'COMPLETED').length };
  });
}

async function loadRoute(client: PoolClient, auth: AuthContext, routeId: string, lock = false): Promise<DeliveryRouteView> {
  const result = await client.query<RouteBase>(
    `${routeSelect} WHERE route.id = $1 ${routeAccess} ${lock ? 'FOR UPDATE OF route' : ''}`,
    [routeId, auth.role, auth.storeIds, auth.userId],
  );
  if (!result.rows[0]) throw notFound('Rota não encontrada.');
  return (await hydrate(client, result.rows))[0]!;
}

async function appendRouteEvent(
  client: PoolClient, auth: AuthContext, routeId: string, eventType: string, metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO route_events (tenant_id, route_id, event_type, actor_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [auth.tenantId, routeId, eventType, auth.userId, JSON.stringify(metadata)],
  );
  await client.query(
    `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'route', $2, $3, $4::jsonb)`,
    [auth.tenantId, routeId, eventType.toLowerCase().replaceAll('_', '.'), JSON.stringify(metadata)],
  );
}

async function appendDeliveryHistory(
  client: PoolClient, auth: AuthContext, deliveryId: string, from: string, to: string, version: number, routeId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO delivery_status_history
      (tenant_id, delivery_id, from_status, to_status, metadata, actor_user_id, delivery_version)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [auth.tenantId, deliveryId, from, to, JSON.stringify({ routeId }), auth.userId, version],
  );
}

async function publishDeliveryEvent(
  client: PoolClient, auth: AuthContext, deliveryId: string, eventType: string, routeId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'delivery', $2, $3, $4::jsonb)`,
    [auth.tenantId, deliveryId, eventType, JSON.stringify({ deliveryId, routeId })],
  );
}

async function refreshEtas(client: PoolClient, routeId: string, baseAt = new Date()): Promise<void> {
  const stops = await client.query<{ id: string; duration_s: number | null }>(
    `SELECT id, estimated_duration_from_previous_s AS duration_s FROM route_stops
     WHERE route_id = $1 AND status = 'PENDING' ORDER BY sequence`, [routeId],
  );
  let cumulativeSeconds = 0;
  for (const stop of stops.rows) {
    cumulativeSeconds += stop.duration_s ?? 0;
    await client.query(`UPDATE route_stops SET estimated_arrival_at = $2::timestamptz
      + ($3::text || ' seconds')::interval WHERE id = $1`, [stop.id, baseAt, cumulativeSeconds]);
  }
  await client.query('UPDATE routes SET eta_calculated_at = now() WHERE id = $1', [routeId]);
}

export async function listRoutes(database: Database, auth: AuthContext): Promise<{ data: DeliveryRouteView[] }> {
  return withTenantTransaction(database, auth, async (client) => {
    const result = await client.query<RouteBase>(
      `${routeSelect} WHERE 1 = 1 ${routeListAccess}
       ORDER BY CASE route.status WHEN 'ACTIVE' THEN 0 WHEN 'DRAFT' THEN 1 ELSE 2 END,
         route.planned_start_at NULLS LAST, route.created_at DESC`,
      [auth.role, auth.storeIds, auth.userId],
    );
    return { data: await hydrate(client, result.rows) };
  });
}

export async function getRouteNavigation(
  database: Database, auth: AuthContext, routeId: string, provider: RouteDirectionsProvider,
): Promise<RouteNavigationView> {
  return withTenantTransaction(database, auth, async (client) => {
    const route = await loadRoute(client, auth, routeId);
    const nextStop = await client.query<{
      id: string; stopType: 'PICKUP' | 'DELIVERY'; label: string; addressLine: string;
      addressNumber: string | null; neighborhood: string | null; city: string; state: string;
      latitude: number; longitude: number;
    }>(
      `SELECT stop.id, stop.stop_type AS "stopType",
        CASE WHEN stop.stop_type = 'PICKUP' THEN store.name ELSE delivery.recipient_name END AS label,
        CASE WHEN stop.stop_type = 'PICKUP' THEN store.address_line ELSE delivery.address_line END AS "addressLine",
        CASE WHEN stop.stop_type = 'PICKUP' THEN store.address_number ELSE delivery.address_number END AS "addressNumber",
        CASE WHEN stop.stop_type = 'PICKUP' THEN store.neighborhood ELSE delivery.neighborhood END AS neighborhood,
        CASE WHEN stop.stop_type = 'PICKUP' THEN store.city ELSE delivery.city END AS city,
        CASE WHEN stop.stop_type = 'PICKUP' THEN store.state ELSE delivery.state END AS state,
        CASE WHEN stop.stop_type = 'PICKUP' THEN store.latitude ELSE delivery.latitude END AS latitude,
        CASE WHEN stop.stop_type = 'PICKUP' THEN store.longitude ELSE delivery.longitude END AS longitude
       FROM route_stops stop
       JOIN deliveries delivery ON delivery.id = stop.delivery_id
       JOIN stores store ON store.id = delivery.store_id
       WHERE stop.route_id = $1 AND stop.status = 'PENDING'
       ORDER BY stop.sequence LIMIT 1`,
      [routeId],
    );
    const destination = nextStop.rows[0];
    if (!destination) throw conflict('A rota não possui uma próxima parada pendente.');

    const current = await client.query<{ latitude: number; longitude: number; capturedAt: Date }>(
      `SELECT latitude, longitude, captured_at AS "capturedAt"
       FROM courier_last_locations
       WHERE tenant_id = $1 AND courier_profile_id = $2`,
      [auth.tenantId, route.courierId],
    );
    const previous = current.rows[0] ? undefined : (await client.query<{ latitude: number; longitude: number }>(
      `SELECT CASE WHEN stop.stop_type = 'PICKUP' THEN store.latitude ELSE delivery.latitude END AS latitude,
              CASE WHEN stop.stop_type = 'PICKUP' THEN store.longitude ELSE delivery.longitude END AS longitude
       FROM route_stops stop
       JOIN deliveries delivery ON delivery.id = stop.delivery_id
       JOIN stores store ON store.id = delivery.store_id
       WHERE stop.route_id = $1 AND stop.status = 'COMPLETED'
       ORDER BY stop.sequence DESC LIMIT 1`,
      [routeId],
    )).rows[0];
    const store = current.rows[0] || previous ? undefined : (await client.query<{ latitude: number; longitude: number }>(
      'SELECT latitude, longitude FROM stores WHERE id = $1', [route.storeId],
    )).rows[0];
    const originPoint = current.rows[0] ?? previous ?? store;
    if (!originPoint) throw notFound('Coordenadas de origem não encontradas.');

    const vehicle = await client.query<{ vehicle_type: string }>(
      'SELECT vehicle_type FROM courier_profiles WHERE id = $1', [route.courierId],
    );
    const modeByVehicle: Record<string, string> = {
      MOTORCYCLE: 'motorcycle', BICYCLE: 'bicycle', CAR: 'drive', VAN: 'light_truck',
    };
    const mode = modeByVehicle[vehicle.rows[0]?.vehicle_type ?? 'CAR'] ?? 'drive';
    let directions: RouteDirectionsResult;
    try {
      directions = await provider.calculateRoute(originPoint, destination, mode);
    } catch {
      throw new AppError(502, 'ROUTE_PROVIDER_UNAVAILABLE',
        'Não foi possível calcular o trajeto agora. Tente novamente em instantes.');
    }
    return {
      routeId, stopId: destination.id, stopType: destination.stopType, mode,
      provider: directions.provider,
      origin: {
        latitude: originPoint.latitude, longitude: originPoint.longitude,
        source: current.rows[0] ? 'LIVE_LOCATION' : previous ? 'PREVIOUS_STOP' : 'STORE',
        capturedAt: current.rows[0]?.capturedAt.toISOString() ?? null,
      },
      destination: {
        latitude: destination.latitude, longitude: destination.longitude, label: destination.label,
        addressLine: destination.addressLine, addressNumber: destination.addressNumber,
        neighborhood: destination.neighborhood, city: destination.city, state: destination.state,
      },
      distanceM: directions.distanceM, durationS: directions.durationS,
      geometry: directions.geometry, instructions: directions.instructions,
      calculatedAt: new Date().toISOString(),
    };
  });
}

export async function createRoute(
  database: Database, auth: AuthContext, key: string,
  input: { storeId: string; courierId: string; deliveryIds: string[]; label: string;
    plannedStartAt?: Date | null | undefined; notes?: string | null | undefined }, ip?: string,
): Promise<IdempotentResult<DeliveryRouteView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, 'route.create', input, async () => {
      if (!canUseStore(auth, input.storeId)) throw forbidden('Você não administra esta loja.');
      const courier = await client.query(
        `SELECT 1 FROM courier_profiles profile JOIN courier_store_links link ON link.courier_profile_id = profile.id
         WHERE profile.id = $1 AND profile.status = 'ACTIVE' AND link.tenant_id = $2
           AND link.store_id = $3 AND link.status = 'ACTIVE'`, [input.courierId, auth.tenantId, input.storeId],
      );
      if (!courier.rowCount) throw notFound('Entregador ativo e vinculado à loja não encontrado.');
      const deliveries = await client.query<{ id: string; version: number }>(
        `SELECT id, version FROM deliveries WHERE id = ANY($1::uuid[]) AND store_id = $2
           AND route_id IS NULL AND status = 'AWAITING_COURIER' FOR UPDATE`, [input.deliveryIds, input.storeId],
      );
      if (deliveries.rowCount !== input.deliveryIds.length) {
        throw conflict('Todas as entregas devem aguardar entregador, pertencer à loja e estar fora de outro lote.');
      }
      const marketplace = await client.query(
        `SELECT 1 FROM delivery_offers WHERE delivery_id = ANY($1::uuid[]) AND status IN ('PUBLISHED', 'ACCEPTED') LIMIT 1`,
        [input.deliveryIds],
      );
      if (marketplace.rowCount) throw conflict('Cancele as ofertas ativas antes de incluir as entregas no lote.');
      const created = await client.query<{ id: string }>(
        `INSERT INTO routes
          (tenant_id, store_id, courier_profile_id, label, notes, planned_start_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
        [auth.tenantId, input.storeId, input.courierId, input.label, input.notes ?? null,
          input.plannedStartAt ?? null, auth.userId],
      );
      const routeId = created.rows[0]!.id;
      const versions = new Map(deliveries.rows.map((item) => [item.id, item.version]));
      for (let index = 0; index < input.deliveryIds.length; index += 1) {
        const deliveryId = input.deliveryIds[index]!; const version = versions.get(deliveryId)!;
        await client.query(
          `UPDATE deliveries SET route_id = $2, courier_profile_id = $3, status = 'AWAITING_PICKUP',
             version = version + 2, updated_by = $4 WHERE id = $1`,
          [deliveryId, routeId, input.courierId, auth.userId],
        );
        await appendDeliveryHistory(client, auth, deliveryId, 'AWAITING_COURIER', 'ASSIGNED', version + 1, routeId);
        await appendDeliveryHistory(client, auth, deliveryId, 'ASSIGNED', 'AWAITING_PICKUP', version + 2, routeId);
        await publishDeliveryEvent(client, auth, deliveryId, 'delivery.assigned', routeId);
        await client.query(
          `INSERT INTO route_stops (tenant_id, route_id, delivery_id, stop_type, sequence)
           VALUES ($1, $2, $3, 'PICKUP', $4), ($1, $2, $3, 'DELIVERY', $5)`,
          [auth.tenantId, routeId, deliveryId, index + 1, input.deliveryIds.length + index + 1],
        );
      }
      await appendRouteEvent(client, auth, routeId, 'ROUTE_CREATED', { deliveryCount: input.deliveryIds.length });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'route.created', entityType: 'route', entityId: routeId,
        afterData: { ...input, deliveryCount: input.deliveryIds.length }, ...(ip ? { ip } : {}) });
      return { body: await loadRoute(client, auth, routeId), statusCode: 201 };
    },
  ));
}

export async function reorderRoute(
  database: Database, auth: AuthContext, key: string, routeId: string, stopIds: string[], ip?: string,
): Promise<IdempotentResult<DeliveryRouteView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `route.reorder:${routeId}`, { stopIds }, async () => {
      const route = await loadRoute(client, auth, routeId, true);
      if (!canUseStore(auth, route.storeId)) throw forbidden('Somente a gestão pode reordenar o lote.');
      if (route.status !== 'DRAFT' || route.stops.some((stop) => stop.status !== 'PENDING')) {
        throw conflict('A sequência só pode mudar antes da primeira coleta.');
      }
      if (new Set(stopIds).size !== route.stops.length || route.stops.some((stop) => !stopIds.includes(stop.id))) {
        throw conflict('A nova sequência deve conter todas as paradas uma única vez.');
      }
      for (const stop of route.stops.filter((item) => item.stopType === 'PICKUP')) {
        const delivery = route.stops.find((item) => item.deliveryId === stop.deliveryId && item.stopType === 'DELIVERY')!;
        if (stopIds.indexOf(stop.id) > stopIds.indexOf(delivery.id)) throw conflict('A coleta deve permanecer antes do destino.');
      }
      const lastPickup = Math.max(...route.stops.filter((item) => item.stopType === 'PICKUP')
        .map((item) => stopIds.indexOf(item.id)));
      const firstDelivery = Math.min(...route.stops.filter((item) => item.stopType === 'DELIVERY')
        .map((item) => stopIds.indexOf(item.id)));
      if (lastPickup > firstDelivery) throw conflict('Todas as coletas devem permanecer antes dos destinos.');
      await client.query('UPDATE route_stops SET sequence = sequence + 10000 WHERE route_id = $1', [routeId]);
      for (let index = 0; index < stopIds.length; index += 1) {
        await client.query('UPDATE route_stops SET sequence = $2, version = version + 1 WHERE id = $1', [stopIds[index], index + 1]);
      }
      await client.query('UPDATE routes SET version = version + 1, updated_by = $2 WHERE id = $1', [routeId, auth.userId]);
      await appendRouteEvent(client, auth, routeId, 'ROUTE_REORDERED', { stopIds });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'route.reordered', entityType: 'route', entityId: routeId,
        beforeData: { stopIds: route.stops.map((stop) => stop.id) }, afterData: { stopIds }, ...(ip ? { ip } : {}) });
      return { body: await loadRoute(client, auth, routeId), statusCode: 200 };
    },
  ));
}

export async function startRoute(
  database: Database, auth: AuthContext, key: string, routeId: string, ip?: string,
): Promise<IdempotentResult<DeliveryRouteView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `route.start:${routeId}`, {}, async () => {
      const route = await loadRoute(client, auth, routeId, true);
      if (route.status !== 'DRAFT') throw conflict('A rota não está pronta para iniciar.');
      if (route.stops.some((stop) => stop.stopType === 'PICKUP' && stop.status !== 'COMPLETED')) {
        throw conflict('Conclua todas as coletas antes de iniciar os destinos.');
      }
      const deliveryStops = route.stops.filter((stop) => stop.stopType === 'DELIVERY' && stop.status === 'PENDING');
      if (!deliveryStops.length) throw conflict('A rota não possui destinos pendentes.');
      for (const stop of deliveryStops) {
        const delivery = await client.query<{ status: string; version: number }>(
          'SELECT status, version FROM deliveries WHERE id = $1 FOR UPDATE', [stop.deliveryId],
        );
        if (delivery.rows[0]?.status !== 'COLLECTED') throw conflict('Todas as encomendas devem estar coletadas.');
        await client.query(
          `UPDATE deliveries SET status = 'IN_ROUTE', out_for_delivery_at = now(), version = version + 1,
             updated_by = $2 WHERE id = $1`, [stop.deliveryId, auth.userId],
        );
        await appendDeliveryHistory(client, auth, stop.deliveryId, 'COLLECTED', 'IN_ROUTE', delivery.rows[0].version + 1, routeId);
        await publishDeliveryEvent(client, auth, stop.deliveryId, 'delivery.start', routeId);
      }
      const first = deliveryStops[0]!;
      const firstRecord = await client.query<{ version: number }>('SELECT version FROM deliveries WHERE id = $1 FOR UPDATE', [first.deliveryId]);
      await client.query(`UPDATE deliveries SET status = 'NEXT_STOP', version = version + 1, updated_by = $2 WHERE id = $1`,
        [first.deliveryId, auth.userId]);
      await appendDeliveryHistory(client, auth, first.deliveryId, 'IN_ROUTE', 'NEXT_STOP', firstRecord.rows[0]!.version + 1, routeId);
      await publishDeliveryEvent(client, auth, first.deliveryId, 'delivery.next-stop', routeId);
      await client.query(`UPDATE routes SET status = 'ACTIVE', started_at = now(), version = version + 1,
        updated_by = $2 WHERE id = $1`, [routeId, auth.userId]);
      await refreshEtas(client, routeId);
      await appendRouteEvent(client, auth, routeId, 'ROUTE_STARTED', { nextDeliveryId: first.deliveryId });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'route.started', entityType: 'route', entityId: routeId, afterData: { nextDeliveryId: first.deliveryId },
        ...(ip ? { ip } : {}) });
      return { body: await loadRoute(client, auth, routeId), statusCode: 200 };
    },
  ));
}

export async function completeRouteStop(
  database: Database, auth: AuthContext, key: string, routeId: string, stopId: string, ip?: string,
): Promise<IdempotentResult<DeliveryRouteView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `route.stop.complete:${stopId}`, {}, async () => {
      const route = await loadRoute(client, auth, routeId, true);
      if (route.status === 'COMPLETED' || route.status === 'CANCELLED') throw conflict('A rota já foi encerrada.');
      const stop = route.stops.find((item) => item.id === stopId);
      if (!stop) throw notFound('Parada não encontrada.');
      if (stop.status !== 'PENDING') throw conflict('A parada já foi encerrada.');
      if (route.stops.some((item) => item.status === 'PENDING' && item.sequence < stop.sequence)) {
        throw conflict('Conclua a parada anterior antes de avançar.');
      }
      const delivery = await client.query<{ status: string; version: number }>(
        'SELECT status, version FROM deliveries WHERE id = $1 FOR UPDATE', [stop.deliveryId],
      );
      const current = delivery.rows[0];
      if (!current) throw notFound('Entrega não encontrada.');
      if (stop.stopType === 'PICKUP') {
        if (route.status !== 'DRAFT' || current.status !== 'AWAITING_PICKUP') throw conflict('A coleta não está disponível.');
        await client.query(`UPDATE deliveries SET status = 'COLLECTED', collected_at = now(), version = version + 1,
          updated_by = $2 WHERE id = $1`, [stop.deliveryId, auth.userId]);
        await appendDeliveryHistory(client, auth, stop.deliveryId, 'AWAITING_PICKUP', 'COLLECTED', current.version + 1, routeId);
        await publishDeliveryEvent(client, auth, stop.deliveryId, 'delivery.collect', routeId);
      } else {
        if (route.status !== 'ACTIVE' || current.status !== 'NEXT_STOP') throw conflict('Este destino ainda não é a próxima parada.');
        await client.query(`UPDATE deliveries SET status = 'DELIVERED', delivered_at = now(), version = version + 1,
          updated_by = $2 WHERE id = $1`, [stop.deliveryId, auth.userId]);
        await appendDeliveryHistory(client, auth, stop.deliveryId, 'NEXT_STOP', 'DELIVERED', current.version + 1, routeId);
        await publishDeliveryEvent(client, auth, stop.deliveryId, 'delivery.complete', routeId);
        await completeOfferForDelivery(client, auth, stop.deliveryId);
      }
      await client.query(`UPDATE route_stops SET status = 'COMPLETED', completed_at = now(),
        completed_by_user_id = $2, version = version + 1 WHERE id = $1`, [stopId, auth.userId]);
      if (stop.stopType === 'DELIVERY') {
        const next = route.stops.find((item) => item.stopType === 'DELIVERY' && item.status === 'PENDING' && item.id !== stopId);
        if (next) {
          const nextRecord = await client.query<{ status: string; version: number }>(
            'SELECT status, version FROM deliveries WHERE id = $1 FOR UPDATE', [next.deliveryId],
          );
          if (nextRecord.rows[0]?.status === 'IN_ROUTE') {
            await client.query(`UPDATE deliveries SET status = 'NEXT_STOP', version = version + 1,
              updated_by = $2 WHERE id = $1`, [next.deliveryId, auth.userId]);
            await appendDeliveryHistory(client, auth, next.deliveryId, 'IN_ROUTE', 'NEXT_STOP',
              nextRecord.rows[0].version + 1, routeId);
            await publishDeliveryEvent(client, auth, next.deliveryId, 'delivery.next-stop', routeId);
          }
        } else {
          await client.query(`UPDATE routes SET status = 'COMPLETED', completed_at = now(),
            version = version + 1, updated_by = $2 WHERE id = $1`, [routeId, auth.userId]);
        }
        await refreshEtas(client, routeId);
      }
      await appendRouteEvent(client, auth, routeId, 'ROUTE_STOP_COMPLETED', {
        stopId, deliveryId: stop.deliveryId, stopType: stop.stopType,
      });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'route.stop.completed', entityType: 'route_stop', entityId: stopId,
        afterData: { routeId, deliveryId: stop.deliveryId, stopType: stop.stopType }, ...(ip ? { ip } : {}) });
      return { body: await loadRoute(client, auth, routeId), statusCode: 200 };
    },
  ));
}

function totalForOrder(matrix: RouteMatrixResult, indices: number[]): { distanceM: number; durationS: number } {
  let distanceM = 0; let durationS = 0; let previous = 0;
  for (const index of indices) {
    const cell = matrix.cells[previous]?.[index];
    if (!cell) throw conflict('A matriz de rotas retornou um trecho inválido.');
    distanceM += cell.distanceM; durationS += cell.durationS; previous = index;
  }
  return { distanceM, durationS };
}

export async function optimizeRoute(
  database: Database, auth: AuthContext, key: string, routeId: string, provider: RouteMatrixProvider, ip?: string,
): Promise<IdempotentResult<DeliveryRouteView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `route.optimize:${routeId}`, {}, async () => {
      const route = await loadRoute(client, auth, routeId, true);
      if (!canUseStore(auth, route.storeId)) throw forbidden('Somente a gestão pode planejar a sequência.');
      if (route.status !== 'DRAFT' || route.stops.some((stop) => stop.status !== 'PENDING')) {
        throw conflict('A sugestão só pode ser calculada antes da primeira coleta.');
      }
      const deliveryStops = route.stops.filter((stop) => stop.stopType === 'DELIVERY');
      if (deliveryStops.length > 30) throw conflict('A otimização aceita até 30 destinos por lote.');
      const coordinates = await client.query<{ id: string; latitude: number; longitude: number; vehicle_type: string }>(
        `SELECT delivery.id, delivery.latitude, delivery.longitude, profile.vehicle_type
         FROM deliveries delivery JOIN routes route ON route.id = delivery.route_id
         JOIN courier_profiles profile ON profile.id = route.courier_profile_id
         WHERE delivery.route_id = $1`, [routeId],
      );
      const store = await client.query<{ latitude: number; longitude: number }>(
        'SELECT latitude, longitude FROM stores WHERE id = $1', [route.storeId],
      );
      const byDelivery = new Map(coordinates.rows.map((item) => [item.id, item]));
      const locations = [store.rows[0]!, ...deliveryStops.map((stop) => byDelivery.get(stop.deliveryId)!)];
      const vehicle = coordinates.rows[0]?.vehicle_type ?? 'CAR';
      const mode = ({ MOTORCYCLE: 'motorcycle', BICYCLE: 'bicycle', CAR: 'drive', VAN: 'light_truck' } as Record<string, string>)[vehicle] ?? 'drive';
      let matrix: RouteMatrixResult;
      try { matrix = await provider.calculate(locations, mode); }
      catch { matrix = await new HaversineRouteMatrixProvider().calculate(locations, mode); }
      const indexByStop = new Map(deliveryStops.map((stop, index) => [stop.id, index + 1]));
      const currentIndices = deliveryStops.map((stop) => indexByStop.get(stop.id)!);
      const unvisited = new Set(currentIndices); const suggestedIndices: number[] = []; let cursor = 0;
      while (unvisited.size) {
        const next = [...unvisited].sort((left, right) =>
          matrix.cells[cursor]![left]!.durationS - matrix.cells[cursor]![right]!.durationS)[0]!;
        suggestedIndices.push(next); unvisited.delete(next); cursor = next;
      }
      const stopByIndex = new Map(deliveryStops.map((stop, index) => [index + 1, stop]));
      const suggestedDeliveries = suggestedIndices.map((index) => stopByIndex.get(index)!);
      const pickups = route.stops.filter((stop) => stop.stopType === 'PICKUP');
      const stopIds = [...pickups.map((stop) => stop.id), ...suggestedDeliveries.map((stop) => stop.id)];
      const current = totalForOrder(matrix, currentIndices); const suggested = totalForOrder(matrix, suggestedIndices);
      const legs = [...pickups.map((stop) => ({ stopId: stop.id, distanceM: 0, durationS: 0 }))];
      let previous = 0;
      for (const index of suggestedIndices) {
        const cell = matrix.cells[previous]![index]!;
        legs.push({ stopId: stopByIndex.get(index)!.id, distanceM: cell.distanceM, durationS: cell.durationS });
        previous = index;
      }
      await client.query(
        `UPDATE routes SET suggested_stop_ids = $2, suggestion_provider = $3,
          suggested_current_distance_m = $4, suggested_total_distance_m = $5,
          suggested_total_duration_s = $6, suggested_legs = $7::jsonb, suggested_at = now(),
          plan_applied_at = NULL, version = version + 1, updated_by = $8 WHERE id = $1`,
        [routeId, stopIds, matrix.provider, current.distanceM, suggested.distanceM, suggested.durationS,
          JSON.stringify(legs), auth.userId],
      );
      await appendRouteEvent(client, auth, routeId, 'ROUTE_OPTIMIZED', { provider: matrix.provider,
        currentDistanceM: current.distanceM, suggestedDistanceM: suggested.distanceM });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'route.optimized', entityType: 'route', entityId: routeId,
        afterData: { provider: matrix.provider, currentDistanceM: current.distanceM,
          suggestedDistanceM: suggested.distanceM }, ...(ip ? { ip } : {}) });
      return { body: await loadRoute(client, auth, routeId), statusCode: 200 };
    },
  ));
}

export async function applyRouteSuggestion(
  database: Database, auth: AuthContext, key: string, routeId: string, ip?: string,
): Promise<IdempotentResult<DeliveryRouteView>> {
  return withTenantTransaction(database, auth, (client) => withIdempotency(
    client, auth, key, `route.suggestion.apply:${routeId}`, {}, async () => {
      const route = await loadRoute(client, auth, routeId, true);
      if (!canUseStore(auth, route.storeId)) throw forbidden('Somente a gestão pode aplicar a sugestão.');
      if (route.status !== 'DRAFT' || route.stops.some((stop) => stop.status !== 'PENDING')) {
        throw conflict('A sugestão só pode ser aplicada antes da primeira coleta.');
      }
      const planning = await client.query<{ suggested_stop_ids: string[] | null; suggested_legs: Array<{
        stopId: string; distanceM: number; durationS: number }> | null; suggested_total_distance_m: number | null;
        suggested_total_duration_s: number | null }>(
        `SELECT suggested_stop_ids, suggested_legs, suggested_total_distance_m, suggested_total_duration_s
         FROM routes WHERE id = $1`, [routeId],
      );
      const plan = planning.rows[0]!;
      if (!plan.suggested_stop_ids || !plan.suggested_legs) throw conflict('Calcule uma sugestão antes de aplicá-la.');
      await client.query('UPDATE route_stops SET sequence = sequence + 10000 WHERE route_id = $1', [routeId]);
      for (let index = 0; index < plan.suggested_stop_ids.length; index += 1) {
        const stopId = plan.suggested_stop_ids[index]!;
        const leg = plan.suggested_legs.find((item) => item.stopId === stopId)!;
        await client.query(`UPDATE route_stops SET sequence = $2, estimated_distance_from_previous_m = $3,
          estimated_duration_from_previous_s = $4, version = version + 1 WHERE id = $1`,
        [stopId, index + 1, leg.distanceM, leg.durationS]);
      }
      await client.query(`UPDATE routes SET plan_applied_at = now(), estimated_total_distance_m = $2,
        estimated_total_duration_s = $3, version = version + 1, updated_by = $4 WHERE id = $1`,
      [routeId, plan.suggested_total_distance_m, plan.suggested_total_duration_s, auth.userId]);
      await refreshEtas(client, routeId, route.plannedStartAt ? new Date(route.plannedStartAt) : new Date());
      await appendRouteEvent(client, auth, routeId, 'ROUTE_SUGGESTION_APPLIED', { stopIds: plan.suggested_stop_ids });
      await writeAudit(client, { tenantId: auth.tenantId, actorUserId: auth.userId,
        action: 'route.suggestion.applied', entityType: 'route', entityId: routeId,
        afterData: { stopIds: plan.suggested_stop_ids }, ...(ip ? { ip } : {}) });
      return { body: await loadRoute(client, auth, routeId), statusCode: 200 };
    },
  ));
}
