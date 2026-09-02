import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import {
  setTenantContext, withRuntimeTransaction, withTenantTransaction, type Database,
} from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import type { AuthContext } from '../auth/auth.types.js';
import type { DeliveryStatus } from '../deliveries/delivery.types.js';
import type { LocationStateStore } from '../locations/location-state.store.js';
import {
  abbreviateCourierName, canRevealDestination, generateTrackingToken, trackingTokenHash,
} from './tracking-token.js';

const anonymousUserId = '00000000-0000-0000-0000-000000000000';
const publicLocationStatuses: DeliveryStatus[] = ['IN_ROUTE', 'NEXT_STOP'];
const unavailableMessage = 'Acompanhamento indisponível.';

interface TrackingDeliveryRow {
  tenantId: string;
  tokenId: string;
  storeName: string;
  storeContactPhone: string | null;
  externalReference: string | null;
  courierName: string | null;
  status: DeliveryStatus;
  addressLine: string;
  addressNumber: string | null;
  neighborhood: string | null;
  city: string;
  state: string;
  postalCode: string | null;
  promisedWindowStart: Date | null;
  promisedWindowEnd: Date | null;
  deliveredAt: Date | null;
  updatedAt: Date;
  expiresAt: Date;
  locationLatitude: number | null;
  locationLongitude: number | null;
  locationAccuracy: number | null;
  locationHeading: number | null;
  locationCapturedAt: Date | null;
  proofId: string | null;
  proofRecipientName: string | null;
  proofCreatedAt: Date | null;
  estimatedArrivalAt: Date | null;
  etaCalculatedAt: Date | null;
  hasPreviousStops: boolean;
}

function assertDeliveryAccess(auth: AuthContext, storeId: string): void {
  if (auth.role !== 'TENANT_MANAGER' && !auth.storeIds.includes(storeId)) {
    throw forbidden('Você não possui acesso à loja desta entrega.');
  }
}

async function findOperationalDelivery(client: PoolClient, auth: AuthContext, deliveryId: string) {
  const result = await client.query<{ id: string; store_id: string; delivered_at: Date | null }>(
    'SELECT id, store_id, delivered_at FROM deliveries WHERE id = $1', [deliveryId],
  );
  const delivery = result.rows[0];
  if (!delivery) throw notFound('Entrega não encontrada.');
  assertDeliveryAccess(auth, delivery.store_id);
  return delivery;
}

function trackingUrl(baseUrl: string, token: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base ? `${base}/${token}` : `/rastrear/${token}`;
}

export async function issueTrackingLink(
  database: Database,
  env: AppEnv,
  auth: AuthContext,
  deliveryId: string,
  ip?: string,
): Promise<{ url: string; expiresAt: Date }> {
  return withTenantTransaction(database, auth, async (client) => {
    const delivery = await findOperationalDelivery(client, auth, deliveryId);
    const token = generateTrackingToken();
    const tokenHash = trackingTokenHash(token, env.TRACKING_TOKEN_PEPPER);
    const absoluteExpiry = new Date(Date.now() + env.TRACKING_TOKEN_TTL_SECONDS * 1000);
    const completedExpiry = delivery.delivered_at
      ? new Date(delivery.delivered_at.getTime() + env.TRACKING_COMPLETED_GRACE_SECONDS * 1000)
      : null;
    const expiresAt = completedExpiry && completedExpiry < absoluteExpiry ? completedExpiry : absoluteExpiry;
    if (expiresAt <= new Date()) {
      throw conflict('A janela pública desta entrega já foi encerrada.');
    }

    await client.query(
      `UPDATE tracking_tokens
       SET revoked_at = now(), revoked_by = $3
       WHERE tenant_id = $1 AND delivery_id = $2 AND revoked_at IS NULL`,
      [auth.tenantId, deliveryId, auth.userId],
    );
    const created = await client.query<{ id: string }>(
      `INSERT INTO tracking_tokens
         (tenant_id, delivery_id, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [auth.tenantId, deliveryId, tokenHash, expiresAt, auth.userId],
    );
    await writeAudit(client, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'tracking_link.issued',
      entityType: 'delivery',
      entityId: deliveryId,
      afterData: { trackingTokenId: created.rows[0]!.id, expiresAt },
      ...(ip === undefined ? {} : { ip }),
    });

    return { url: trackingUrl(env.PUBLIC_TRACKING_BASE_URL, token), expiresAt };
  });
}

export async function revokeTrackingLink(
  database: Database,
  auth: AuthContext,
  deliveryId: string,
  ip?: string,
): Promise<{ revoked: boolean }> {
  return withTenantTransaction(database, auth, async (client) => {
    await findOperationalDelivery(client, auth, deliveryId);
    const result = await client.query(
      `UPDATE tracking_tokens
       SET revoked_at = now(), revoked_by = $3
       WHERE tenant_id = $1 AND delivery_id = $2 AND revoked_at IS NULL`,
      [auth.tenantId, deliveryId, auth.userId],
    );
    await writeAudit(client, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'tracking_link.revoked',
      entityType: 'delivery',
      entityId: deliveryId,
      afterData: { revoked: Boolean(result.rowCount) },
      ...(ip === undefined ? {} : { ip }),
    });
    return { revoked: Boolean(result.rowCount) };
  });
}

export async function getPublicTracking(
  database: Database,
  env: AppEnv,
  state: LocationStateStore,
  token: string,
  ip?: string,
) {
  const hash = trackingTokenHash(token, env.TRACKING_TOKEN_PEPPER);
  return withRuntimeTransaction(database, async (client) => {
    await client.query("SELECT set_config('app.tracking_hash', $1, true)", [hash]);
    const lookup = await client.query<{ id: string; tenant_id: string; delivery_id: string }>(
      `SELECT id, tenant_id, delivery_id
       FROM tracking_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
         AND rastreia.tenant_is_active(tenant_id)
       LIMIT 1`,
      [hash],
    );
    const match = lookup.rows[0];
    if (!match) throw notFound(unavailableMessage);

    await setTenantContext(client, { tenantId: match.tenant_id, userId: anonymousUserId });
    const deliveryResult = await client.query<TrackingDeliveryRow>(
      `SELECT token.tenant_id AS "tenantId", token.id AS "tokenId",
              store.name AS "storeName", store.contact_phone AS "storeContactPhone",
              delivery.external_reference AS "externalReference",
              courier_user.name AS "courierName", delivery.status,
              delivery.address_line AS "addressLine", delivery.address_number AS "addressNumber",
              delivery.neighborhood, delivery.city, delivery.state,
              delivery.postal_code AS "postalCode",
              delivery.promised_window_start AS "promisedWindowStart",
              delivery.promised_window_end AS "promisedWindowEnd",
              delivery.delivered_at AS "deliveredAt", delivery.updated_at AS "updatedAt",
              last_location.latitude AS "locationLatitude",
              last_location.longitude AS "locationLongitude",
              last_location.accuracy AS "locationAccuracy",
              last_location.heading AS "locationHeading",
              last_location.captured_at AS "locationCapturedAt",
              proof.id AS "proofId", proof.recipient_name AS "proofRecipientName",
              proof.created_at AS "proofCreatedAt",
              route_stop.estimated_arrival_at AS "estimatedArrivalAt",
              route.eta_calculated_at AS "etaCalculatedAt",
              EXISTS (SELECT 1 FROM route_stops previous_stop
                WHERE previous_stop.route_id = delivery.route_id AND previous_stop.stop_type = 'DELIVERY'
                  AND previous_stop.status = 'PENDING' AND previous_stop.sequence < route_stop.sequence) AS "hasPreviousStops",
              LEAST(
                token.expires_at,
                COALESCE(delivery.delivered_at + ($2::text || ' seconds')::interval, token.expires_at)
              ) AS "expiresAt"
       FROM tracking_tokens token
       JOIN deliveries delivery ON delivery.id = token.delivery_id
       JOIN stores store ON store.id = delivery.store_id
       LEFT JOIN courier_profiles courier ON courier.id = delivery.courier_profile_id
       LEFT JOIN users courier_user ON courier_user.id = courier.user_id
       LEFT JOIN routes route ON route.id = delivery.route_id
       LEFT JOIN route_stops route_stop ON route_stop.route_id = delivery.route_id
         AND route_stop.delivery_id = delivery.id AND route_stop.stop_type = 'DELIVERY'
       LEFT JOIN courier_last_locations last_location
         ON last_location.tenant_id = delivery.tenant_id
        AND last_location.courier_profile_id = delivery.courier_profile_id
        AND last_location.delivery_id = delivery.id
       LEFT JOIN LATERAL (
         SELECT candidate.id, candidate.recipient_name, candidate.created_at
         FROM delivery_proofs candidate
         WHERE candidate.delivery_id = delivery.id AND candidate.public_visible
         ORDER BY candidate.created_at DESC LIMIT 1
       ) proof ON true
       WHERE token.id = $1 AND token.revoked_at IS NULL AND token.expires_at > now()
         AND (delivery.delivered_at IS NULL
              OR delivery.delivered_at + ($2::text || ' seconds')::interval > now())`,
      [match.id, env.TRACKING_COMPLETED_GRACE_SECONDS],
    );
    const delivery = deliveryResult.rows[0];
    if (!delivery) throw notFound(unavailableMessage);

    const touched = await client.query(
      `UPDATE tracking_tokens
       SET last_access_at = now(), last_access_ip = $2::inet, access_count = access_count + 1
       WHERE id = $1 AND revoked_at IS NULL`,
      [delivery.tokenId, ip ?? null],
    );
    if (!touched.rowCount) throw notFound(unavailableMessage);

    const history = await client.query<{ status: DeliveryStatus; occurredAt: Date }>(
      `SELECT to_status AS status, created_at AS "occurredAt"
       FROM delivery_status_history
       WHERE delivery_id = $1
       ORDER BY delivery_version`,
      [match.delivery_id],
    );
    const revealDestination = canRevealDestination(delivery.status);
    const operationalNotices=(await client.query(`SELECT status,message,occurred_at AS "occurredAt",resolved_at AS "resolvedAt",affects_eta AS "affectsEta"
      FROM rastreia.public_driver_event_notices($1)`,[match.delivery_id])).rows;
    const cachedLocation = await state.getDelivery(match.tenant_id, match.delivery_id);
    const databaseLocation = delivery.locationLatitude !== null
      && delivery.locationLongitude !== null
      && delivery.locationAccuracy !== null
      && delivery.locationCapturedAt !== null
      ? {
          latitude: delivery.locationLatitude,
          longitude: delivery.locationLongitude,
          accuracy: delivery.locationAccuracy,
          heading: delivery.locationHeading,
          capturedAt: delivery.locationCapturedAt,
        }
      : null;
    const selectedLocation = cachedLocation?.publicVisible
      && (!databaseLocation || cachedLocation.capturedAt > databaseLocation.capturedAt)
      ? cachedLocation
      : databaseLocation;
    return {
      store: { name: delivery.storeName, contactPhone: delivery.storeContactPhone },
      reference: delivery.externalReference,
      status: delivery.status,
      operationalNotices,
      etaSubjectToChange: operationalNotices.some(notice=>notice.affectsEta===true),
      courier: { displayName: abbreviateCourierName(delivery.courierName) },
      destination: {
        addressLine: revealDestination ? delivery.addressLine : null,
        addressNumber: revealDestination ? delivery.addressNumber : null,
        neighborhood: revealDestination ? delivery.neighborhood : null,
        city: delivery.city,
        state: delivery.state,
        postalCode: revealDestination ? delivery.postalCode : null,
        protectedUntilInRoute: !revealDestination,
      },
      promisedWindow: {
        start: delivery.promisedWindowStart,
        end: delivery.promisedWindowEnd,
      },
      eta: delivery.estimatedArrivalAt ? {
        estimatedArrivalAt: delivery.estimatedArrivalAt,
        calculatedAt: delivery.etaCalculatedAt,
        message: delivery.hasPreviousStops ? 'O entregador está concluindo entregas anteriores.' : 'Sua entrega é a próxima parada.',
      } : null,
      location: publicLocationStatuses.includes(delivery.status) && selectedLocation
        ? {
            latitude: selectedLocation.latitude,
            longitude: selectedLocation.longitude,
            accuracy: selectedLocation.accuracy,
            heading: selectedLocation.heading,
            capturedAt: selectedLocation.capturedAt,
            stale: selectedLocation.capturedAt.getTime() < Date.now() - 120_000,
          }
        : null,
      proof: delivery.status === 'DELIVERED' && delivery.proofId !== null
        ? { available: true, recipientName: delivery.proofRecipientName, capturedAt: delivery.proofCreatedAt }
        : { available: false, recipientName: null, capturedAt: null },
      deliveredAt: delivery.deliveredAt,
      updatedAt: delivery.updatedAt,
      expiresAt: delivery.expiresAt,
      history: history.rows,
    };
  });
}

export async function resolvePublicTrackingSocket(
  database: Database,
  env: AppEnv,
  token: string,
): Promise<{ tokenId: string; tenantId: string; deliveryId: string }> {
  const hash = trackingTokenHash(token, env.TRACKING_TOKEN_PEPPER);
  return withRuntimeTransaction(database, async (client) => {
    await client.query("SELECT set_config('app.tracking_hash', $1, true)", [hash]);
    const lookup = await client.query<{ id: string; tenant_id: string; delivery_id: string }>(
      `SELECT id, tenant_id, delivery_id
       FROM tracking_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
         AND rastreia.tenant_is_active(tenant_id)
       LIMIT 1`,
      [hash],
    );
    const match = lookup.rows[0];
    if (!match) throw notFound(unavailableMessage);
    await setTenantContext(client, { tenantId: match.tenant_id, userId: anonymousUserId });
    const valid = await client.query(
      `SELECT 1
       FROM tracking_tokens token
       JOIN deliveries delivery ON delivery.id = token.delivery_id
       WHERE token.id = $1 AND token.revoked_at IS NULL AND token.expires_at > now()
         AND (delivery.delivered_at IS NULL
              OR delivery.delivered_at + ($2::text || ' seconds')::interval > now())`,
      [match.id, env.TRACKING_COMPLETED_GRACE_SECONDS],
    );
    if (!valid.rowCount) throw notFound(unavailableMessage);
    return { tokenId: match.id, tenantId: match.tenant_id, deliveryId: match.delivery_id };
  });
}
