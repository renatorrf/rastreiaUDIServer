import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { setTenantContext, withRuntimeTransaction, withTenantTransaction, type Database } from '../../database/pool.js';
import { forbidden, notFound, unauthorized, validationError } from '../../shared/errors.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import type { AuthContext } from '../auth/auth.types.js';
import { generateTrackingToken, trackingTokenHash } from '../tracking/tracking-token.js';
import { customerPhoneMatches, normalizeCustomerPhone } from './customer-phone.js';

const anonymousUserId = '00000000-0000-0000-0000-000000000000';
const sessionLifetimeMs = 180 * 24 * 60 * 60 * 1000;
const publicTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const customerTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const registrationSchema = z.object({
  trackingToken: publicTokenSchema,
  firstName: z.string().trim().min(2).max(80),
  lastName: z.string().trim().min(2).max(120),
  whatsapp: z.string().trim().min(10).max(20),
  addressLine: z.string().trim().min(3).max(240),
  addressNumber: z.string().trim().min(1).max(30),
  complement: z.string().trim().max(120).nullable().optional(),
  neighborhood: z.string().trim().min(2).max(120),
  city: z.string().trim().min(2).max(120),
  state: z.string().trim().length(2).toUpperCase(),
  postalCode: z.string().trim().regex(/^\d{5}-?\d{3}$/),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  addressConfidence: z.number().min(0).max(1).nullable().optional(),
  consent: z.literal(true),
});

const customerSearchSchema = z.object({
  whatsapp: z.string().trim().min(8).max(20),
  storeId: z.uuid().optional(),
});

const pushSubscriptionSchema = z.object({
  endpoint: z.url().max(2048),
  expirationTime: z.coerce.date().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(20).max(512), auth: z.string().min(8).max(256) }),
});

const pushRemovalSchema = z.object({ endpoint: z.url().max(2048) });

interface CustomerSessionScope { tenantId: string; customerId: string }

function customerToken(request: FastifyRequest): string {
  const token = request.headers['x-customer-token'];
  if (typeof token !== 'string' || !customerTokenSchema.safeParse(token).success) throw unauthorized('Acesso do cliente inválido.');
  return token;
}

async function withCustomerSession<T>(database: Database, env: AppEnv, request: FastifyRequest,
  callback: (client: PoolClient, scope: CustomerSessionScope) => Promise<T>): Promise<T> {
  const hash = trackingTokenHash(customerToken(request), env.TRACKING_TOKEN_PEPPER);
  return withRuntimeTransaction(database, async client => {
    await client.query("SELECT set_config('app.customer_session_hash',$1,true)", [hash]);
    const scope = (await client.query<{ tenant_id: string; customer_profile_id: string }>(`
      SELECT tenant_id,customer_profile_id FROM customer_sessions
      WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() LIMIT 1`, [hash])).rows[0];
    if (!scope) throw unauthorized('A sessão do cliente expirou. Abra novamente um link de rastreio válido.');
    await setTenantContext(client, { tenantId: scope.tenant_id, userId: anonymousUserId });
    await client.query('UPDATE customer_sessions SET last_used_at=now() WHERE token_hash=$1', [hash]);
    return callback(client, { tenantId: scope.tenant_id, customerId: scope.customer_profile_id });
  });
}

function customerSelect() {
  return `SELECT id,first_name AS "firstName",last_name AS "lastName",whatsapp,
    address_line AS "addressLine",address_number AS "addressNumber",complement,neighborhood,city,state,
    postal_code AS "postalCode",created_at AS "createdAt",updated_at AS "updatedAt" FROM customer_profiles`;
}

function assertStoreScope(auth: AuthContext, storeId: string | undefined): void {
  if (storeId && auth.role !== 'TENANT_MANAGER' && !auth.storeIds.includes(storeId)) {
    throw forbidden('Você não possui acesso à loja selecionada.');
  }
}

export async function customerRoutes(app: FastifyInstance, database: Database, env: AppEnv): Promise<void> {
  const auth = authenticate(env, database);

  app.post('/public/customers/register', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async request => {
    const input = registrationSchema.parse(request.body);
    const trackingHash = trackingTokenHash(input.trackingToken, env.TRACKING_TOKEN_PEPPER);
    return withRuntimeTransaction(database, async client => {
      await client.query("SELECT set_config('app.tracking_hash',$1,true)", [trackingHash]);
      const link = (await client.query<{ id: string; tenant_id: string; delivery_id: string }>(`
        SELECT id,tenant_id,delivery_id FROM tracking_tokens
        WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() LIMIT 1`, [trackingHash])).rows[0];
      if (!link) throw notFound('O link de rastreio expirou ou foi substituído.');
      await setTenantContext(client, { tenantId: link.tenant_id, userId: anonymousUserId });
      const delivery = (await client.query<{ recipient_phone: string; recipient_whatsapp: string | null }>(`
        SELECT recipient_phone,recipient_whatsapp FROM deliveries WHERE id=$1`, [link.delivery_id])).rows[0];
      if (!delivery) throw notFound('Entrega não encontrada.');
      if (!customerPhoneMatches(input.whatsapp, delivery.recipient_whatsapp ?? delivery.recipient_phone)) {
        throw validationError({ whatsapp: 'Use o WhatsApp informado para esta entrega.' });
      }
      const normalized = normalizeCustomerPhone(input.whatsapp);
      if (!/^\d{10,11}$/.test(normalized)) throw validationError({ whatsapp: 'Informe um WhatsApp brasileiro com DDD.' });
      const profile = (await client.query<{ id: string }>(`
        INSERT INTO customer_profiles(tenant_id,first_name,last_name,whatsapp,whatsapp_normalized,address_line,
          address_number,complement,neighborhood,city,state,postal_code,latitude,longitude,address_confidence,source_tracking_token_id,last_order_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
        ON CONFLICT(tenant_id,whatsapp_normalized) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,
          whatsapp=EXCLUDED.whatsapp,address_line=EXCLUDED.address_line,address_number=EXCLUDED.address_number,
          complement=EXCLUDED.complement,neighborhood=EXCLUDED.neighborhood,city=EXCLUDED.city,state=EXCLUDED.state,
          postal_code=EXCLUDED.postal_code,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,
          address_confidence=EXCLUDED.address_confidence,status='ACTIVE',consent_at=now(),last_order_at=now()
        RETURNING id`, [link.tenant_id, input.firstName, input.lastName, input.whatsapp, normalized, input.addressLine,
        input.addressNumber, input.complement ?? null, input.neighborhood, input.city, input.state, input.postalCode,
        input.latitude, input.longitude, input.addressConfidence ?? null, link.id])).rows[0]!;
      await client.query(`UPDATE deliveries SET customer_profile_id=$2
        WHERE tenant_id=$1 AND customer_profile_id IS NULL
          AND regexp_replace(COALESCE(NULLIF(recipient_whatsapp,''),recipient_phone),'[^0-9]','','g') IN ($3,'55'||$3)`,
      [link.tenant_id, profile.id, normalized]);
      const token = generateTrackingToken();
      const expiresAt = new Date(Date.now() + sessionLifetimeMs);
      await client.query(`INSERT INTO customer_sessions(id,tenant_id,customer_profile_id,token_hash,expires_at,last_used_at)
        VALUES($1,$2,$3,$4,$5,now())`, [randomUUID(), link.tenant_id, profile.id,
        trackingTokenHash(token, env.TRACKING_TOKEN_PEPPER), expiresAt]);
      const customer = (await client.query(`${customerSelect()} WHERE id=$1`, [profile.id])).rows[0];
      return { accessToken: token, expiresAt, customer };
    });
  });

  app.get('/customer/me', async request => withCustomerSession(database, env, request, async (client, scope) => {
    const customer = (await client.query(`${customerSelect()} WHERE id=$1`, [scope.customerId])).rows[0];
    if (!customer) throw notFound('Cadastro do cliente não encontrado.');
    return customer;
  }));

  app.get('/customer/orders', async request => withCustomerSession(database, env, request, async (client, scope) => ({
    data: (await client.query(`SELECT delivery.id,delivery.external_reference AS "reference",delivery.status,
      delivery.created_at AS "createdAt",delivery.delivered_at AS "deliveredAt",delivery.address_line AS "addressLine",
      delivery.address_number AS "addressNumber",store.name AS "storeName",store.contact_phone AS "storeWhatsapp"
      FROM deliveries delivery JOIN stores store ON store.id=delivery.store_id
      WHERE delivery.customer_profile_id=$1 ORDER BY delivery.created_at DESC LIMIT 100`, [scope.customerId])).rows,
  })));

  app.delete('/customer/session', async request => withCustomerSession(database, env, request, async (client) => {
    const hash = trackingTokenHash(customerToken(request), env.TRACKING_TOKEN_PEPPER);
    await client.query('UPDATE customer_sessions SET revoked_at=now() WHERE token_hash=$1', [hash]);
    return { revoked: true };
  }));

  app.get('/customer/push/status', async request => withCustomerSession(database, env, request, async (client, scope) => {
    const row = (await client.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM customer_push_subscriptions WHERE customer_profile_id=$1 AND active`, [scope.customerId])).rows[0];
    return {
      configured: Boolean(env.PUSH_VAPID_SUBJECT && env.PUSH_VAPID_PUBLIC_KEY && env.PUSH_VAPID_PRIVATE_KEY),
      publicKey: env.PUSH_VAPID_PUBLIC_KEY || null,
      activeDevices: Number(row?.count ?? 0),
    };
  }));

  app.put('/customer/push/subscriptions', async request => {
    const input = pushSubscriptionSchema.parse(request.body);
    return withCustomerSession(database, env, request, async (client, scope) => {
      const endpointHash = createHash('sha256').update(input.endpoint).digest('hex');
      const row = (await client.query<{ id: string }>(`INSERT INTO customer_push_subscriptions
        (tenant_id,customer_profile_id,endpoint,endpoint_hash,p256dh,auth_secret,expiration_time,user_agent,active,failure_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,0)
        ON CONFLICT(tenant_id,customer_profile_id,endpoint_hash) DO UPDATE SET endpoint=EXCLUDED.endpoint,
          p256dh=EXCLUDED.p256dh,auth_secret=EXCLUDED.auth_secret,expiration_time=EXCLUDED.expiration_time,
          user_agent=EXCLUDED.user_agent,active=true,failure_count=0,last_failure_at=NULL
        RETURNING id`, [scope.tenantId, scope.customerId, input.endpoint, endpointHash, input.keys.p256dh,
        input.keys.auth, input.expirationTime ?? null, request.headers['user-agent'] ?? null])).rows[0]!;
      return { id: row.id, active: true };
    });
  });

  app.delete('/customer/push/subscriptions', async request => {
    const input = pushRemovalSchema.parse(request.body);
    return withCustomerSession(database, env, request, async (client, scope) => {
      const endpointHash = createHash('sha256').update(input.endpoint).digest('hex');
      const result = await client.query(`UPDATE customer_push_subscriptions SET active=false
        WHERE customer_profile_id=$1 AND endpoint_hash=$2`, [scope.customerId, endpointHash]);
      return { removed: Boolean(result.rowCount) };
    });
  });

  app.get('/customers/search', { preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')] }, async request => {
    const input = customerSearchSchema.parse(request.query);
    assertStoreScope(request.auth, input.storeId);
    const normalized = normalizeCustomerPhone(input.whatsapp);
    if (normalized.length < 8) throw validationError({ whatsapp: 'Digite ao menos 8 números.' });
    return withTenantTransaction(database, request.auth, async client => ({
      data: (await client.query(`SELECT customer.id,customer.first_name AS "firstName",customer.last_name AS "lastName",
        customer.whatsapp,customer.address_line AS "addressLine",customer.address_number AS "addressNumber",
        customer.complement,customer.neighborhood,customer.city,customer.state,customer.postal_code AS "postalCode",
        customer.latitude,customer.longitude,customer.address_confidence::float8 AS "addressConfidence",
        count(delivery.id)::int AS "ordersCount",max(delivery.created_at) AS "lastOrderAt"
        FROM customer_profiles customer JOIN deliveries delivery ON delivery.customer_profile_id=customer.id
        WHERE customer.status='ACTIVE' AND position($1 in customer.whatsapp_normalized)>0
          AND ($2::uuid IS NULL OR delivery.store_id=$2)
          AND ($3::text='TENANT_MANAGER' OR delivery.store_id=ANY($4::uuid[]))
        GROUP BY customer.id ORDER BY max(delivery.created_at) DESC LIMIT 10`,
      [normalized, input.storeId ?? null, request.auth.role, request.auth.storeIds])).rows,
    }));
  });
}
