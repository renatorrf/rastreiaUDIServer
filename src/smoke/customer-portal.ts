import { randomBytes, randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from '../database/pool.js';
import { trackingTokenHash } from '../modules/tracking/tracking-token.js';

interface RegistrationBody {
  accountCreated: true;
  email: string;
  temporaryPassword: string;
  customer: { id: string };
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
const email = `customer-portal-${runId}@example.invalid`;
const permanentPassword = `Customer-${runId}-safe`;
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
     VALUES($1,$2,$3,$4,'Cliente Smoke','(11) 9888-8888','Rua Vergueiro','100','Liberdade',
       'São Paulo','SP','01504-000',-23.5733,-46.6404,'DELIVERED')`,
    [deliveryId, tenantId, storeId, `customer-${runId}`],
  );
  await client.query(
    `INSERT INTO rastreia.tracking_tokens(id,tenant_id,delivery_id,token_hash,created_at,expires_at)
     VALUES($1,$2,$3,$4,now()-interval '2 hours',now()-interval '1 hour')`,
    [trackingId, tenantId, deliveryId, trackingTokenHash(trackingToken, env.TRACKING_TOKEN_PEPPER)],
  );
});

const app = await buildApp({ env: smokeEnv });
try {
  const wrongPhone = await app.inject({
    method: 'POST',
    url: '/public/customers/register',
    payload: {
      trackingToken,
      email: `wrong-${email}`,
      firstName: 'Cliente',
      lastName: 'Incorreto',
      whatsapp: '(11) 97777-7777',
      addressLine: 'Rua Vergueiro',
      addressNumber: '100',
      neighborhood: 'Liberdade',
      city: 'São Paulo',
      state: 'SP',
      postalCode: '01504-000',
      latitude: -23.5733,
      longitude: -46.6404,
      addressConfidence: 1,
      consent: true,
    },
  });
  if (wrongPhone.statusCode !== 422) {
    throw new Error(`WhatsApp diferente da entrega deveria retornar 422, recebeu ${wrongPhone.statusCode}: ${wrongPhone.body}`);
  }

  const registration = body<RegistrationBody>(await app.inject({
    method: 'POST',
    url: '/public/customers/register',
    payload: {
      trackingToken,
      email,
      firstName: 'Cliente',
      lastName: 'Smoke',
      whatsapp: '(11) 99888-8888',
      addressLine: 'Rua Vergueiro',
      addressNumber: '100',
      complement: null,
      neighborhood: 'Liberdade',
      city: 'São Paulo',
      state: 'SP',
      postalCode: '01504-000',
      latitude: -23.5733,
      longitude: -46.6404,
      addressConfidence: 1,
      consent: true,
    },
  }), 200, 'cadastrar cliente com WhatsApp legado da entrega');
  customerProfileId = registration.customer.id;
  if (!registration.accountCreated || registration.email !== email || registration.temporaryPassword.length !== 8) {
    throw new Error('O cadastro não retornou a conta e a senha temporária esperadas.');
  }

  const temporaryIdentity = body<IdentityBody>(await app.inject({
    method: 'POST',
    url: '/auth/sign-in',
    payload: { email, password: registration.temporaryPassword },
  }), 200, 'entrar com a senha temporária');
  customerUserId = temporaryIdentity.user.id;
  if (!temporaryIdentity.user.mustChangePassword || temporaryIdentity.customer?.id !== customerProfileId) {
    throw new Error('O primeiro login não exigiu a troca de senha ou perdeu o perfil do cliente.');
  }

  const blockedProfile = await app.inject({
    method: 'GET',
    url: '/customer/me',
    headers: { authorization: `Bearer ${temporaryIdentity.accessToken}` },
  });
  if (blockedProfile.statusCode !== 409) {
    throw new Error(`O perfil deveria permanecer bloqueado antes da troca de senha, recebeu ${blockedProfile.statusCode}.`);
  }

  body(await app.inject({
    method: 'PATCH',
    url: '/auth/password',
    headers: { authorization: `Bearer ${temporaryIdentity.accessToken}` },
    payload: { currentPassword: registration.temporaryPassword, newPassword: permanentPassword },
  }), 200, 'trocar a senha temporária');

  body(await app.inject({
    method: 'GET',
    url: '/customer/me',
    headers: { authorization: `Bearer ${temporaryIdentity.accessToken}` },
  }), 200, 'abrir as informações pessoais do cliente');
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
    url: '/auth/sign-in',
    payload: { email, password: permanentPassword },
  }), 200, 'entrar com a senha definitiva');
  if (permanentIdentity.user.mustChangePassword || permanentIdentity.customer?.id !== customerProfileId) {
    throw new Error('O login definitivo retornou um contexto incorreto.');
  }
  const oldPassword = await app.inject({
    method: 'POST',
    url: '/auth/sign-in',
    payload: { email, password: registration.temporaryPassword },
  });
  if (oldPassword.statusCode !== 401) {
    throw new Error(`A senha temporária deveria ter sido invalidada, recebeu ${oldPassword.statusCode}.`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    expiredTrackingLinkAcceptedWithinGrace: true,
    differentWhatsappRejected: true,
    legacyTenDigitMobileMatched: true,
    temporaryPasswordLength: registration.temporaryPassword.length,
    passwordChangeRequired: true,
    temporaryPasswordInvalidated: true,
    customerProfileAccessible: true,
    orderHistoryLinked: true,
    permanentLoginSuccessful: true,
  }, null, 2)}\n`);
} finally {
  await app.close();
  try {
    await withTransaction(database, async client => {
      if (!customerUserId) {
        customerUserId = (await client.query<{ id: string }>(
          'SELECT id FROM rastreia.users WHERE email=$1::citext', [email],
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
