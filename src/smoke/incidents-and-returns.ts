import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTransaction } from '../database/pool.js';
import { LocalObjectStorage } from '../integrations/objects/object-storage.js';

interface LoginBody { accessToken: string }
interface EntityBody { id: string; userId?: string; status?: string }
interface IncidentBody extends EntityBody {
  deliveryId: string; evidenceCount: number; status: string;
  events?: Array<{ eventType: string; version: number }>;
}

function body<T>(response: LightMyRequestResponse, expected: number, step: string): T {
  if (response.statusCode !== expected) throw new Error(`${step}: HTTP ${response.statusCode} - ${response.body}`);
  return response.json<T>();
}

function imageMultipart(image: Buffer): { boundary: string; payload: Buffer } {
  const boundary = `rastreia-incident-${randomUUID()}`;
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="evidence"; filename="incident.png"\r\nContent-Type: image/png\r\n\r\n`),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

loadLocalEnv();
const env = getEnv();
if (!env.BOOTSTRAP_TENANT_SLUG || !env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_PASSWORD) {
  throw new Error('Preencha as credenciais BOOTSTRAP_* para o smoke de ocorrências.');
}

const runId = randomUUID();
const prefix = `incident-smoke-${runId}`;
const smokeEnv = { ...env, OBJECT_STORAGE_PROVIDER: 'local' as const, OBJECT_STORAGE_PATH: `.data/${prefix}` };
let storeId: string | undefined;
let courierId: string | undefined;
let courierUserId: string | undefined;
let deliveryId: string | undefined;
const incidentIds: string[] = [];
const evidenceKeys: string[] = [];

const app = await buildApp({ env: smokeEnv });
try {
  const manager = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD,
  } }), 200, 'login do gestor');
  const managerHeaders = { authorization: `Bearer ${manager.accessToken}` };
  storeId = body<EntityBody>(await app.inject({ method: 'POST', url: '/stores', headers: managerHeaders, payload: {
    name: `Loja Ocorrências ${runId.slice(0, 8)}`, externalReference: prefix,
    addressLine: 'Avenida Paulista', city: 'São Paulo', state: 'SP', latitude: -23.5614, longitude: -46.6559,
  } }), 201, 'criar loja').id;
  const courierEmail = `${prefix}@example.invalid`;
  const courierPassword = `Incident-${runId}-safe`;
  const courier = body<EntityBody>(await app.inject({ method: 'POST', url: '/couriers', headers: managerHeaders, payload: {
    name: 'Entregador Ocorrência Smoke', email: courierEmail, password: courierPassword,
    phone: '+5511999999999', vehicleType: 'MOTORCYCLE', storeIds: [storeId],
  } }), 201, 'criar entregador');
  courierId = courier.id; courierUserId = courier.userId;
  const courierLogin = body<LoginBody>(await app.inject({ method: 'POST', url: '/auth/login', payload: {
    tenantSlug: env.BOOTSTRAP_TENANT_SLUG, email: courierEmail, password: courierPassword,
  } }), 200, 'login do entregador');
  const courierHeaders = { authorization: `Bearer ${courierLogin.accessToken}` };

  deliveryId = body<EntityBody>(await app.inject({ method: 'POST', url: '/deliveries', headers: {
    ...managerHeaders, 'idempotency-key': `${prefix}-delivery`,
  }, payload: {
    storeId, externalReference: prefix, recipientName: 'Cliente Ocorrência', recipientPhone: '+5511988888888',
    addressLine: 'Rua Vergueiro', city: 'São Paulo', state: 'SP', latitude: -23.5733, longitude: -46.6404,
  } }), 201, 'criar entrega').id;
  body(await app.inject({ method: 'POST', url: `/deliveries/${deliveryId}/assign`, headers: {
    ...managerHeaders, 'idempotency-key': `${prefix}-assign`,
  }, payload: { courierId } }), 200, 'atribuir entrega');
  for (const [index, action] of ['collect', 'start'].entries()) {
    body(await app.inject({ method: 'POST', url: `/deliveries/${deliveryId}/${action}`, headers: {
      ...courierHeaders, 'idempotency-key': `${prefix}-${action}-${index}`,
    } }), 200, action);
  }
  body(await app.inject({ method: 'POST', url: `/deliveries/${deliveryId}/fail`, headers: {
    ...courierHeaders, 'idempotency-key': `${prefix}-fail`,
  }, payload: { reason: 'Destinatário ausente após tentativas de contato' } }), 200, 'registrar falha');

  const queue = body<{ data: IncidentBody[] }>(await app.inject({ method: 'GET', url: '/incidents', headers: managerHeaders }), 200, 'listar fila');
  const automatic = queue.data.find((item) => item.deliveryId === deliveryId);
  if (!automatic || automatic.status !== 'OPEN') throw new Error('A falha não abriu uma ocorrência automaticamente.');
  incidentIds.push(automatic.id);

  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const multipart = imageMultipart(image);
  body(await app.inject({ method: 'POST', url: `/incidents/${automatic.id}/evidence?notes=Porta%20fechada`, headers: {
    ...courierHeaders, 'idempotency-key': `${prefix}-evidence`, 'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
  }, payload: multipart.payload }), 201, 'anexar evidência');

  body(await app.inject({ method: 'POST', url: `/incidents/${automatic.id}/review`, headers: {
    ...managerHeaders, 'idempotency-key': `${prefix}-review`,
  }, payload: { type: 'RECIPIENT_ABSENT', severity: 'HIGH', notes: 'Contato confirmado sem resposta no endereço' } }), 200, 'iniciar análise');
  body(await app.inject({ method: 'POST', url: `/incidents/${automatic.id}/resolve`, headers: {
    ...managerHeaders, 'idempotency-key': `${prefix}-resolve`,
  }, payload: { resolution: 'RETURN_TO_STORE', notes: 'Retornar o volume lacrado à unidade de origem' } }), 200, 'iniciar devolução');
  const returningDelivery = body<EntityBody>(await app.inject({ method: 'GET', url: `/deliveries/${deliveryId}`, headers: managerHeaders }), 200, 'consultar devolução');
  if (returningDelivery.status !== 'RETURN_STARTED') throw new Error('A decisão não iniciou a devolução na entrega.');

  body(await app.inject({ method: 'POST', url: `/incidents/${automatic.id}/complete-return`, headers: {
    ...courierHeaders, 'idempotency-key': `${prefix}-return-complete`,
  }, payload: { notes: 'Volume recebido lacrado pelo operador da loja' } }), 200, 'concluir devolução');
  const returnedDelivery = body<EntityBody>(await app.inject({ method: 'GET', url: `/deliveries/${deliveryId}`, headers: managerHeaders }), 200, 'consultar entrega devolvida');
  if (returnedDelivery.status !== 'RETURNED') throw new Error('A entrega não foi encerrada como devolvida.');
  const resolved = body<IncidentBody>(await app.inject({ method: 'GET', url: `/incidents/${automatic.id}`, headers: managerHeaders }), 200, 'consultar ocorrência resolvida');
  if (resolved.status !== 'RESOLVED' || resolved.evidenceCount !== 1 || (resolved.events?.length ?? 0) < 5) {
    throw new Error('A ocorrência não preservou evidência ou linha do tempo completa.');
  }

  const manualRequest = { method: 'POST' as const, url: '/incidents', headers: {
    ...managerHeaders, 'idempotency-key': `${prefix}-manual`,
  }, payload: {
    deliveryId, type: 'DAMAGE', severity: 'MEDIUM', title: 'Embalagem amassada',
    description: 'Avaria externa identificada após o retorno à loja',
  } };
  const manualResponse = await app.inject(manualRequest);
  const manual = body<IncidentBody>(manualResponse, 201, 'abrir ocorrência manual');
  incidentIds.push(manual.id);
  const replay = await app.inject(manualRequest);
  if (replay.statusCode !== 201 || replay.headers['idempotency-replayed'] !== 'true'
      || replay.json<IncidentBody>().id !== manual.id) throw new Error('A abertura manual não preservou idempotência.');
  body(await app.inject({ method: 'POST', url: `/incidents/${manual.id}/resolve`, headers: {
    ...managerHeaders, 'idempotency-key': `${prefix}-manual-resolve`,
  }, payload: { resolution: 'NO_RETURN', notes: 'Avaria apenas cosmética registrada para controle' } }), 200, 'resolver ocorrência manual');

  process.stdout.write(`${JSON.stringify({
    ok: true, automaticFailureIncident: true, privateEvidenceStored: true, reviewTimeline: true,
    returnStateMachine: ['DELIVERY_FAILED', 'RETURN_STARTED', 'RETURNED'], courierCompletedReturn: true,
    manualIncidentIdempotent: true,
  }, null, 2)}\n`);
} finally {
  await app.close();
  const cleanup = createPool(env);
  try {
    await withTransaction(cleanup, async (client) => {
      if (incidentIds.length) {
        const keys = await client.query<{ object_key: string }>('SELECT object_key FROM rastreia.incident_evidence WHERE incident_id = ANY($1::uuid[])', [incidentIds]);
        evidenceKeys.push(...keys.rows.map((row) => row.object_key));
        await client.query('DELETE FROM rastreia.incident_evidence WHERE incident_id = ANY($1::uuid[])', [incidentIds]);
        await client.query('DELETE FROM rastreia.incident_events WHERE incident_id = ANY($1::uuid[])', [incidentIds]);
        await client.query('DELETE FROM rastreia.incidents WHERE id = ANY($1::uuid[])', [incidentIds]);
      }
      await client.query('DELETE FROM rastreia.idempotency_keys WHERE idempotency_key LIKE $1', [`${prefix}%`]);
      await client.query('DELETE FROM rastreia.outbox_events WHERE aggregate_id = ANY($1::uuid[])', [[...incidentIds, deliveryId].filter(Boolean)]);
      if (deliveryId) {
        await client.query('DELETE FROM rastreia.delivery_status_history WHERE delivery_id = $1', [deliveryId]);
        await client.query('DELETE FROM rastreia.deliveries WHERE id = $1', [deliveryId]);
      }
      const entityIds = [storeId, courierId, deliveryId, ...incidentIds].filter((id): id is string => Boolean(id));
      if (entityIds.length) await client.query('DELETE FROM rastreia.audit_logs WHERE entity_id = ANY($1::uuid[])', [entityIds]);
      if (courierId) {
        await client.query('DELETE FROM rastreia.courier_store_links WHERE courier_profile_id = $1', [courierId]);
        await client.query('DELETE FROM rastreia.courier_profiles WHERE id = $1', [courierId]);
      }
      if (courierUserId) {
        await client.query('DELETE FROM rastreia.refresh_sessions WHERE user_id = $1', [courierUserId]);
        await client.query('DELETE FROM rastreia.tenant_users WHERE user_id = $1', [courierUserId]);
        await client.query('DELETE FROM rastreia.users WHERE id = $1', [courierUserId]);
      }
      if (storeId) await client.query('DELETE FROM rastreia.stores WHERE id = $1', [storeId]);
    });
  } finally { await cleanup.end(); }
  const storage = new LocalObjectStorage(smokeEnv.OBJECT_STORAGE_PATH);
  for (const key of evidenceKeys) await storage.remove(key);
}
