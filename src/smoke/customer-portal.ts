import { randomBytes, randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from '../database/pool.js';
import { trackingTokenHash } from '../modules/tracking/tracking-token.js';

interface RegistrationBody {
  accountCreated: true;
  whatsapp: string;
}

interface IdentityBody {
  accessToken: string;
  user: { id: string; mustChangePassword: boolean };
  customer: { id: string } | null;
}

function body<T>(response: LightMyRequestResponse, expectedStatus: number, step: string): T {
  if (response.statusCode !== expectedStatus) {
    throw new Error(`${step}: HTTP ${response.statusCode} - ${response.body}`);
  }
  return response.json<T>();
}

loadLocalEnv();
const env = getEnv();
const smokeEnv = {
  ...env,
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'error' as const,
  REDIS_URL: '',
  REDIS_REQUIRED: false,
  COMMUNICATIONS_MOCK: true,
};
const runId = randomUUID();
const suffix = runId.slice(0, 8);
const tenantId = randomUUID();
const companyId = randomUUID();
const storeId = randomUUID();
const deliveryId = randomUUID();
const trackingId = randomUUID();
const trackingToken = randomBytes(32).toString('base64url');
const permanentPassword = `Customer-${runId}-safe`;
const customerPhone = `119${String(Number.parseInt(suffix,16)).padStart(8,'0').slice(-8)}`;
let customerProfileId: string | undefined;
let customerUserId: string | undefined;

const database = createPool(env);
await withTransaction(database, async client => {
  await client.query(
    `INSERT INTO rastreia.tenants(id,slug,name)
     VALUES($1,$2,$3)`,
    [tenantId, `customer-${suffix}`, `Empresa Customer ${suffix}`],
  );
  await client.query(
    `INSERT INTO rastreia.companies(id,tenant_id,name,legal_name)
     VALUES($1,$2,$3,$4)`,
    [companyId, tenantId, `Empresa Customer ${suffix}`, `Empresa Customer ${suffix} LTDA`],
  );
  await client.query(
    `INSERT INTO rastreia.stores(id,tenant_id,company_id,name,address_line,address_number,
       neighborhood,city,state,postal_code,latitude,longitude,address_confidence,contact_phone)
     VALUES($1,$2,$3,$4,'Avenida Paulista','1000','Bela Vista','São Paulo','SP','01310-100',
       -23.5614,-46.6559,1,'551140000000')`,
    [storeId, tenantId, companyId, `Loja Customer ${suffix}`],
  );
  await client.query(
    `INSERT INTO rastreia.deliveries(id,tenant_id,store_id,external_reference,recipient_name,
       recipient_phone,address_line,address_number,neighborhood,city,state,postal_code,latitude,longitude,status)
     VALUES($1,$2,$3,$4,'Cliente Smoke',$5,'Rua Vergueiro','100','Liberdade',
       'São Paulo','SP','01504-000',-23.5733,-46.6404,'DELIVERED')`,
    [deliveryId, tenantId, storeId, `customer-${runId}`, customerPhone],
  );
  await client.query(
    `INSERT INTO rastreia.tracking_tokens(id,tenant_id,delivery_id,token_hash,created_at,expires_at)
     VALUES($1,$2,$3,$4,now()-interval '2 hours',now()-interval '1 hour')`,
    [trackingId, tenantId, deliveryId, trackingTokenHash(trackingToken, env.TRACKING_TOKEN_PEPPER)],
  );
});

const app = await buildApp({ env: smokeEnv });
try {
  const shortPassword = await app.inject({
    method: 'POST',
    url: '/public/customers/register',
    payload: {
      trackingToken,
      password: 'short',
      consent: true,
    },
  });
  if (shortPassword.statusCode !== 422) {
    throw new Error(`Senha curta deveria retornar 422, recebeu ${shortPassword.statusCode}.`);
  }

  const registration = body<RegistrationBody>(await app.inject({
    method: 'POST',
    url: '/public/customers/register',
    payload: {
      trackingToken,
      password: permanentPassword,
      consent: true,
    },
  }), 200, 'ativar cliente com os dados da entrega');
  if (!registration.accountCreated || registration.whatsapp !== customerPhone) {
    throw new Error('O cadastro não retornou a conta esperada.');
  }

  const temporaryIdentity = body<IdentityBody>(await app.inject({
    method: 'POST',
    url: '/auth/customer/sign-in',
    payload: { whatsapp: `+55 ${customerPhone}`, password: permanentPassword },
  }), 200, 'entrar com WhatsApp e senha escolhida');
  customerUserId = temporaryIdentity.user.id;
  customerProfileId = temporaryIdentity.customer?.id;
  if (temporaryIdentity.user.mustChangePassword || !customerProfileId) {
    throw new Error('O login não retornou o perfil do cliente ou exigiu troca de senha indevida.');
  }

  const duplicate = await app.inject({method:'POST',url:'/public/customers/register',
    payload:{trackingToken,password:'Different123',consent:true}});
  if (duplicate.statusCode !== 409) {
    throw new Error(`Nova ativação deveria retornar 409, recebeu ${duplicate.statusCode}.`);
  }

  body(await app.inject({
    method: 'GET',
    url: '/customer/me',
    headers: { authorization: `Bearer ${temporaryIdentity.accessToken}` },
  }), 200, 'abrir as informações pessoais do cliente');
  const customerTracking = body<{ status: string; reference: string | null }>(await app.inject({
    method: 'GET',
    url: `/customer/orders/${deliveryId}/tracking`,
    headers: { authorization: `Bearer ${temporaryIdentity.accessToken}` },
  }), 200, 'abrir o rastreio autenticado do pedido');
  if (customerTracking.status !== 'DELIVERED' || customerTracking.reference !== `customer-${runId}`) {
    throw new Error('O rastreio autenticado não retornou o pedido vinculado ao cliente.');
  }
  const unrelatedTracking = await app.inject({
    method: 'GET',
    url: `/customer/orders/${randomUUID()}/tracking`,
    headers: { authorization: `Bearer ${temporaryIdentity.accessToken}` },
  });
  if (unrelatedTracking.statusCode !== 404) {
    throw new Error(`Um pedido não vinculado ao cliente deveria retornar 404, recebeu ${unrelatedTracking.statusCode}.`);
  }
  const orders = body<{ data: Array<{ id: string }> }>(await app.inject({
    method: 'GET',
    url: '/customer/orders',
    headers: { authorization: `Bearer ${temporaryIdentity.accessToken}` },
  }), 200, 'listar o histórico de pedidos');
  if (!orders.data.some(order => order.id === deliveryId)) {
    throw new Error('O pedido que originou o cadastro não foi associado ao histórico do cliente.');
  }

  const permanentIdentity = body<IdentityBody>(await app.inject({
    method: 'POST',
    url: '/auth/customer/sign-in',
    payload: { whatsapp: customerPhone, password: permanentPassword },
  }), 200, 'entrar com a senha definitiva');
  if (permanentIdentity.user.mustChangePassword || permanentIdentity.customer?.id !== customerProfileId) {
    throw new Error('O login definitivo retornou um contexto incorreto.');
  }
  const oldPassword = await app.inject({
    method: 'POST',
    url: '/auth/customer/sign-in',
    payload: { whatsapp: customerPhone, password: 'Different123' },
  });
  if (oldPassword.statusCode !== 401) {
    throw new Error(`A senha não cadastrada deveria ser rejeitada, recebeu ${oldPassword.statusCode}.`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    expiredTrackingLinkAcceptedWithinGrace: true,
    shortPasswordRejected: true,
    formattedWhatsappAccepted: true,
    duplicateActivationRejected: true,
    wrongPasswordRejected: true,
    customerProfileAccessible: true,
    orderHistoryLinked: true,
    authenticatedTrackingAvailable: true,
    unrelatedTrackingRejected: true,
    permanentLoginSuccessful: true,
  }, null, 2)}\n`);
} finally {
  await app.close();
  try {
    await withTransaction(database, async client => {
      if (!customerUserId) {
        customerUserId = (await client.query<{ id: string }>(
          'SELECT account.id FROM rastreia.users account JOIN rastreia.customer_profiles profile ON profile.user_id=account.id WHERE profile.tenant_id=$1', [tenantId],
        )).rows[0]?.id;
      }
      if (!customerProfileId) {
        customerProfileId = (await client.query<{ id: string }>(
          'SELECT id FROM rastreia.customer_profiles WHERE tenant_id=$1', [tenantId],
        )).rows[0]?.id;
      }
      if (customerUserId) {
        await client.query('DELETE FROM rastreia.identity_sessions WHERE user_id=$1', [customerUserId]);
        await client.query('DELETE FROM rastreia.refresh_sessions WHERE user_id=$1', [customerUserId]);
      }
      await client.query('DELETE FROM rastreia.tracking_tokens WHERE id=$1', [trackingId]);
      await client.query('DELETE FROM rastreia.deliveries WHERE id=$1', [deliveryId]);
      if (customerProfileId) {
        await client.query('DELETE FROM rastreia.customer_profiles WHERE id=$1', [customerProfileId]);
      }
      if (customerUserId) await client.query('DELETE FROM rastreia.users WHERE id=$1', [customerUserId]);
      await client.query('DELETE FROM rastreia.stores WHERE id=$1', [storeId]);
      await client.query('DELETE FROM rastreia.companies WHERE id=$1', [companyId]);
      await client.query('DELETE FROM rastreia.tenants WHERE id=$1', [tenantId]);
    });
  } finally {
    await database.end();
  }
}
