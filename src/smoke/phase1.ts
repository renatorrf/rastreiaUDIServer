import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { io, type Socket } from 'socket.io-client';
import { buildApp } from '../app.js';
import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool, withTenantTransaction, withTransaction } from '../database/pool.js';
import { LocalObjectStorage } from '../integrations/objects/object-storage.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import { nativeLocationEventId } from '../modules/locations/background-tracking-token.js';
import { trackingTokenHash } from '../modules/tracking/tracking-token.js';
import { processNotificationBatch } from '../workers/notification-worker.service.js';

interface LoginBody {
  accessToken: string;
}

interface EntityBody {
  id: string;
  status?: string;
  history?: Array<{ toStatus: string }>;
}

interface TrackingLinkBody {
  url: string;
  expiresAt: string;
}

interface PublicTrackingBody {
  status: string;
  destination: { addressLine: string | null; protectedUntilInRoute: boolean };
  courier: { displayName: string | null };
  history: Array<{ status: string }>;
  location: { latitude: number; longitude: number; accuracy: number; capturedAt: string } | null;
  proof: { available: boolean; recipientName: string | null; capturedAt: string | null };
}

interface ProofBody { id: string; mimeType: string; recipientName: string | null }
interface MessageBody {
  id: string; status: string; providerMessageId: string | null; channel: string;
}

interface LocationResponseBody {
  accepted: number;
  rejected: number;
  results: Array<{ eventId: string; accepted: boolean; duplicate?: boolean }>;
}

interface BackgroundTrackingSessionBody {
  id: string;
  token: string;
  deliveryId: string;
  expiresAt: string;
}

function waitForConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

function waitForLocation(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Tempo real não recebeu a localização.')), 4_000);
    socket.once('location:update', (location: Record<string, unknown>) => {
      clearTimeout(timeout);
      resolve(location);
    });
  });
}

function tokenFrom(url: string): string {
  const token = new URL(url, 'http://local.test').pathname.split('/').filter(Boolean).at(-1);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Token público inválido na resposta.');
  return token;
}

function body<T>(response: LightMyRequestResponse, expectedStatus: number, step: string): T {
  if (response.statusCode !== expectedStatus) {
    throw new Error(`${step}: HTTP ${response.statusCode} - ${response.body}`);
  }
  return response.json<T>();
}

function imageMultipart(image: Buffer): { boundary: string; payload: Buffer } {
  const boundary = `rastreia-${randomUUID()}`;
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="proof"; filename="proof.png"\r\nContent-Type: image/png\r\n\r\n`),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

loadLocalEnv();
const env = getEnv();
if (!env.BOOTSTRAP_TENANT_SLUG || !env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_PASSWORD) {
  throw new Error('Preencha BOOTSTRAP_TENANT_SLUG, BOOTSTRAP_ADMIN_EMAIL e BOOTSTRAP_ADMIN_PASSWORD.');
}

const runId = randomUUID();
const smokeEnv = { ...env, COMMUNICATIONS_MOCK: true, OBJECT_STORAGE_PATH: `.data/smoke-${runId}` };
const idempotencyPrefix = `smoke-${runId}`;
let storeId: string | undefined;
let courierId: string | undefined;
let courierUserId: string | undefined;
let deliveryId: string | undefined;
let backgroundSessionId: string | undefined;
let backgroundSessionToken: string | undefined;
const proofObjectKeys: string[] = [];
const sessionIds: string[] = [];
const foreignTenantId = randomUUID();
const setupDatabase = createPool(env);
await withTransaction(setupDatabase, async (client) => {
  await client.query(
    `INSERT INTO rastreia.tenants (id, slug, name)
     VALUES ($1, $2, 'Tenant isolado do smoke test')`,
    [foreignTenantId, `smoke-${runId}`],
  );
});
await setupDatabase.end();
const app = await buildApp({ env: smokeEnv });
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
if (!address || typeof address === 'string') throw new Error('Servidor de smoke não abriu uma porta TCP.');
const realtimeUrl = `http://127.0.0.1:${address.port}`;

try {
  const login = body<LoginBody>(await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      tenantSlug: env.BOOTSTRAP_TENANT_SLUG,
      email: env.BOOTSTRAP_ADMIN_EMAIL,
      password: env.BOOTSTRAP_ADMIN_PASSWORD,
    },
  }), 200, 'login');
  const auth = await verifyAccessToken(env, login.accessToken);
  sessionIds.push(auth.sessionId);
  const headers = { authorization: `Bearer ${login.accessToken}` };

  const runtimeDatabase = createPool(env);
  const runtimeCheck = await withTenantTransaction(runtimeDatabase, auth, async (client) => {
    const result = await client.query<{ current_role: string; visible_tenants: string }>(
      `SELECT current_user AS current_role,
              (SELECT count(*)::text FROM tenants) AS visible_tenants`,
    );
    return result.rows[0];
  }).finally(() => runtimeDatabase.end());
  if (runtimeCheck?.current_role !== 'rastreia_runtime' || runtimeCheck.visible_tenants !== '1') {
    throw new Error(`RLS runtime invÃ¡lido: ${JSON.stringify(runtimeCheck)}`);
  }

  const store = body<EntityBody>(await app.inject({
    method: 'POST',
    url: '/stores',
    headers,
    payload: {
      name: `Loja Smoke ${runId.slice(0, 8)}`,
      externalReference: idempotencyPrefix,
      addressLine: 'Avenida Paulista',
      addressNumber: '1000',
      neighborhood: 'Bela Vista',
      city: 'SÃ£o Paulo',
      state: 'SP',
      postalCode: '01310-100',
      latitude: -23.561414,
      longitude: -46.655881,
      addressConfidence: 1,
    },
  }), 201, 'criar loja');
  storeId = store.id;

  const courier = body<EntityBody>(await app.inject({
    method: 'POST',
    url: '/couriers',
    headers,
    payload: {
      name: 'Entregador Smoke',
      email: `smoke-${runId}@example.invalid`,
      password: `Smoke-${runId}-safe`,
      phone: '+5511999999999',
      vehicleType: 'MOTORCYCLE',
      storeIds: [storeId],
    },
  }), 201, 'criar entregador');
  courierId = courier.id;

  const denied = await app.inject({
    method: 'POST',
    url: '/deliveries',
    headers: { authorization: 'Bearer invalid-before-courier-login', 'idempotency-key': `${idempotencyPrefix}-denied` },
    payload: { storeId },
  });
  if (denied.statusCode !== 401) throw new Error(`Token invÃ¡lido deveria retornar 401, recebeu ${denied.statusCode}.`);

  const deliveryPayload = {
    storeId,
    externalReference: idempotencyPrefix,
    recipientName: 'Cliente Smoke',
    recipientPhone: '+5511988888888',
    addressLine: 'Rua Vergueiro',
    addressNumber: '100',
    neighborhood: 'Liberdade',
    city: 'SÃ£o Paulo',
    state: 'SP',
    postalCode: '01504-000',
    latitude: -23.5733,
    longitude: -46.6404,
    addressConfidence: 1,
    deliveryInstructions: 'Teste automatizado temporÃ¡rio',
  };
  const createKey = `${idempotencyPrefix}-create`;
  const createResponse = await app.inject({
    method: 'POST', url: '/deliveries',
    headers: { ...headers, 'idempotency-key': createKey }, payload: deliveryPayload,
  });
  const delivery = body<EntityBody>(createResponse, 201, 'criar entrega');
  deliveryId = delivery.id;
  if (delivery.status !== 'AWAITING_COURIER' || createResponse.headers['idempotency-replayed'] !== 'false') {
    throw new Error('CriaÃ§Ã£o retornou estado ou cabeÃ§alho idempotente inesperado.');
  }

  const replayResponse = await app.inject({
    method: 'POST', url: '/deliveries',
    headers: { ...headers, 'idempotency-key': createKey }, payload: deliveryPayload,
  });
  const replay = body<EntityBody>(replayResponse, 201, 'repetir criaÃ§Ã£o');
  if (replay.id !== deliveryId || replayResponse.headers['idempotency-replayed'] !== 'true') {
    throw new Error('A repetiÃ§Ã£o idempotente criou um resultado diferente.');
  }

  const firstLink = body<TrackingLinkBody>(await app.inject({
    method: 'POST', url: `/deliveries/${deliveryId}/tracking-link`, headers,
  }), 200, 'emitir primeiro link público');
  const firstToken = tokenFrom(firstLink.url);
  const firstPublicResponse = await app.inject({ method: 'GET', url: `/public/tracking/${firstToken}` });
  const firstPublic = body<PublicTrackingBody>(firstPublicResponse, 200, 'abrir primeiro link público');
  if (firstPublicResponse.headers['cache-control'] !== 'no-store'
      || firstPublicResponse.headers['referrer-policy'] !== 'no-referrer') {
    throw new Error('Cabeçalhos públicos de privacidade ausentes.');
  }
  if (!firstPublic.destination.protectedUntilInRoute || firstPublic.destination.addressLine !== null) {
    throw new Error('O endereço deveria permanecer protegido antes do trajeto.');
  }
  const serializedPublic = JSON.stringify(firstPublic);
  if (serializedPublic.includes(deliveryId) || serializedPublic.includes(deliveryPayload.recipientPhone)
      || serializedPublic.includes(firstToken)) {
    throw new Error('O DTO público expôs um identificador, telefone ou token proibido.');
  }

  const activeLink = body<TrackingLinkBody>(await app.inject({
    method: 'POST', url: `/deliveries/${deliveryId}/tracking-link`, headers,
  }), 200, 'reemitir link público');
  const activeToken = tokenFrom(activeLink.url);
  const replacedResponse = await app.inject({ method: 'GET', url: `/public/tracking/${firstToken}` });
  if (replacedResponse.statusCode !== 404) throw new Error('O link anterior continuou válido após a reemissão.');

  const actions: Array<{ name: string; payload?: object; expected: string }> = [
    { name: 'assign', payload: { courierId }, expected: 'AWAITING_PICKUP' },
  ];
  for (const [index, action] of actions.entries()) {
    const changed = body<EntityBody>(await app.inject({
      method: 'POST',
      url: `/deliveries/${deliveryId}/${action.name}`,
      headers: { ...headers, 'idempotency-key': `${idempotencyPrefix}-${index}` },
      ...(action.payload === undefined ? {} : { payload: action.payload }),
    }), 200, action.name);
    if (changed.status !== action.expected) {
      throw new Error(`${action.name}: esperado ${action.expected}, recebido ${changed.status ?? 'sem status'}`);
    }
  }

  const courierLogin = body<LoginBody>(await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: {
      tenantSlug: env.BOOTSTRAP_TENANT_SLUG,
      email: `smoke-${runId}@example.invalid`,
      password: `Smoke-${runId}-safe`,
    },
  }), 200, 'login do entregador');
  const courierAuth = await verifyAccessToken(env, courierLogin.accessToken);
  sessionIds.push(courierAuth.sessionId);
  const courierHeaders = { authorization: `Bearer ${courierLogin.accessToken}` };

  const pushEndpoints = [
    `https://push.example.invalid/${runId}/device-a`,
    `https://push.example.invalid/${runId}/device-b`,
  ];
  for (const endpoint of pushEndpoints) {
    body<{ active: boolean }>(await app.inject({
      method: 'PUT', url: '/push/subscriptions', headers: courierHeaders,
      payload: { endpoint, expirationTime: null,
        keys: { p256dh: 'p256dh-smoke-key-with-enough-length', auth: 'auth-smoke-key' } },
    }), 200, 'registrar dispositivo push');
  }
  let pushStatus = body<{ activeDevices: number }>(await app.inject({
    method: 'GET', url: '/push/status', headers: courierHeaders,
  }), 200, 'consultar dispositivos push');
  if (pushStatus.activeDevices !== 2) throw new Error('Subscriptions push de múltiplos dispositivos não foram preservadas.');
  body<{ removed: boolean }>(await app.inject({
    method: 'DELETE', url: '/push/subscriptions', headers: courierHeaders,
    payload: { endpoint: pushEndpoints[0] },
  }), 200, 'desativar dispositivo push');
  pushStatus = body<{ activeDevices: number }>(await app.inject({
    method: 'GET', url: '/push/status', headers: courierHeaders,
  }), 200, 'recontar dispositivos push');
  if (pushStatus.activeDevices !== 1) throw new Error('A remoção seletiva da subscription push falhou.');

  const forbiddenCreate = await app.inject({
    method: 'POST',
    url: '/deliveries',
    headers: { ...courierHeaders, 'idempotency-key': `${idempotencyPrefix}-role-denied` },
    payload: deliveryPayload,
  });
  if (forbiddenCreate.statusCode !== 403) {
    throw new Error(`Entregador nÃ£o deveria criar entrega: HTTP ${forbiddenCreate.statusCode}.`);
  }

  const operationalActions = [
    { name: 'collect', expected: 'COLLECTED' },
    { name: 'start', expected: 'IN_ROUTE' },
    { name: 'complete', expected: 'DELIVERED' },
  ];
  for (const [index, action] of operationalActions.entries()) {
    const changed = body<EntityBody>(await app.inject({
      method: 'POST',
      url: `/deliveries/${deliveryId}/${action.name}`,
      headers: { ...courierHeaders, 'idempotency-key': `${idempotencyPrefix}-courier-${index}` },
    }), 200, `${action.name} como entregador`);
    if (changed.status !== action.expected) {
      throw new Error(`${action.name}: esperado ${action.expected}, recebido ${changed.status ?? 'sem status'}`);
    }
    if (action.name === 'collect') {
      const firstPoint = {
        eventId: randomUUID(), deliveryId, latitude: -23.5615, longitude: -46.6558,
        accuracy: 12, speed: 4, heading: 120, altitude: null,
        capturedAt: new Date(Date.now() - 45_000).toISOString(),
      };
      const locationKey = `${idempotencyPrefix}-location-single`;
      const locationResponse = await app.inject({
        method: 'POST', url: '/courier/location',
        headers: { ...courierHeaders, 'idempotency-key': locationKey }, payload: firstPoint,
      });
      body<LocationResponseBody>(locationResponse, 202, 'enviar primeira localização');
      const locationReplay = await app.inject({
        method: 'POST', url: '/courier/location',
        headers: { ...courierHeaders, 'idempotency-key': locationKey }, payload: firstPoint,
      });
      if (locationReplay.statusCode !== 202 || locationReplay.headers['idempotency-replayed'] !== 'true') {
        throw new Error('A localização individual não preservou idempotência.');
      }
      const eventReplay = body<LocationResponseBody>(await app.inject({
        method: 'POST', url: '/courier/location',
        headers: { ...courierHeaders, 'idempotency-key': `${locationKey}-new-request` }, payload: firstPoint,
      }), 202, 'repetir evento de localização');
      if (!eventReplay.results[0]?.duplicate) {
        throw new Error('O identificador do evento não evitou a duplicação com nova chave de requisição.');
      }
      const collectedPublic = body<PublicTrackingBody>(await app.inject({
        method: 'GET', url: `/public/tracking/${activeToken}`,
      }), 200, 'consultar entrega coletada');
      if (collectedPublic.location !== null) {
        throw new Error('Localização pública apareceu antes do início do trajeto.');
      }
    }
    if (action.name === 'start') {
      const operationsSocket = io(`${realtimeUrl}/operations`, {
        auth: { accessToken: login.accessToken }, transports: ['websocket'], forceNew: true,
      });
      const trackingSocket = io(`${realtimeUrl}/tracking`, {
        auth: { token: activeToken }, transports: ['websocket'], forceNew: true,
      });
      try {
        await Promise.all([waitForConnect(operationsSocket), waitForConnect(trackingSocket)]);
        const operationsEvent = waitForLocation(operationsSocket);
        const trackingEvent = waitForLocation(trackingSocket);
        const validBatchPoint = {
          eventId: randomUUID(), deliveryId, latitude: -23.5617, longitude: -46.6556,
          accuracy: 9, speed: 5, heading: 125, altitude: null,
          capturedAt: new Date(Date.now() - 2_000).toISOString(),
        };
        const inaccuratePoint = {
          ...validBatchPoint, eventId: randomUUID(), accuracy: 180,
          capturedAt: new Date(Date.now() - 1_000).toISOString(),
        };
        const batch = body<LocationResponseBody>(await app.inject({
          method: 'POST', url: '/courier/location/batch',
          headers: { ...courierHeaders, 'idempotency-key': `${idempotencyPrefix}-location-batch` },
          payload: { points: [validBatchPoint, inaccuratePoint] },
        }), 200, 'enviar lote de localizações');
        if (batch.accepted !== 1 || batch.rejected !== 1) {
          throw new Error(`Lote deveria aceitar 1 e rejeitar 1 ponto: ${JSON.stringify(batch)}.`);
        }
        const [internalLive, publicLive] = await Promise.all([operationsEvent, trackingEvent]);
        if (internalLive['deliveryId'] !== deliveryId || 'deliveryId' in publicLive || 'courierId' in publicLive) {
          throw new Error('Escopo dos eventos Socket.IO não separou payload interno e público.');
        }
      } finally {
        operationsSocket.disconnect();
        trackingSocket.disconnect();
      }

      const activeLocations = body<{ data: Array<{ deliveryId: string; stale: boolean }> }>(await app.inject({
        method: 'GET', url: '/locations/active', headers,
      }), 200, 'listar localizações ativas');
      if (!activeLocations.data.some((location) => location.deliveryId === deliveryId && !location.stale)) {
        throw new Error('A localização atual não apareceu no painel operacional.');
      }

      const backgroundSession = body<BackgroundTrackingSessionBody>(await app.inject({
        method: 'POST',
        url: '/courier/background-tracking-sessions',
        headers: courierHeaders,
        payload: { deliveryId, platform: 'android' },
      }), 201, 'autorizar rastreamento nativo');
      backgroundSessionId = backgroundSession.id;
      backgroundSessionToken = backgroundSession.token;
      const nativePoint = {
        latitude: -23.5618,
        longitude: -46.6555,
        accuracy: 8,
        altitude: null,
        bearing: 130,
        speed: 5,
        time: Date.now(),
        source: 'native' as const,
      };
      const nativeResult = body<{ accepted: boolean; eventId: string }>(await app.inject({
        method: 'POST',
        url: '/mobile/location',
        headers: { authorization: `Bearer ${backgroundSession.token}` },
        payload: nativePoint,
      }), 202, 'enviar localização pelo serviço nativo');
      const expectedNativeEventId = nativeLocationEventId(backgroundSession.id, nativePoint);
      if (!nativeResult.accepted || nativeResult.eventId !== expectedNativeEventId) {
        throw new Error('O endpoint nativo não derivou o recibo esperado.');
      }
      const nativeQueueReplay = body<LocationResponseBody>(await app.inject({
        method: 'POST',
        url: '/courier/location/batch',
        headers: { ...courierHeaders, 'idempotency-key': `${idempotencyPrefix}-native-queue-replay` },
        payload: { points: [{
          eventId: expectedNativeEventId,
          deliveryId,
          latitude: nativePoint.latitude,
          longitude: nativePoint.longitude,
          accuracy: nativePoint.accuracy,
          altitude: nativePoint.altitude,
          heading: nativePoint.bearing,
          speed: nativePoint.speed,
          capturedAt: new Date(nativePoint.time).toISOString(),
        }] },
      }), 200, 'deduplicar fila do serviço nativo');
      if (!nativeQueueReplay.results[0]?.duplicate) {
        throw new Error('O POST nativo e a fila JavaScript duplicaram a localização.');
      }
      const publicInRoute = body<PublicTrackingBody>(await app.inject({
        method: 'GET', url: `/public/tracking/${activeToken}`,
      }), 200, 'acompanhar entrega em rota');
      if (publicInRoute.destination.protectedUntilInRoute
          || publicInRoute.destination.addressLine !== 'Rua Vergueiro'
          || !publicInRoute.location) {
        throw new Error('O endereço próprio não foi revelado ao iniciar o trajeto.');
      }
      if (publicInRoute.courier.displayName !== 'Entregador S.') {
        throw new Error(`Nome público do entregador inesperado: ${publicInRoute.courier.displayName ?? 'ausente'}.`);
      }
      if (publicInRoute.proof.available) throw new Error('Comprovante público apareceu antes da conclusão.');

      const image = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      );
      const multipart = imageMultipart(image);
      const proofKey = `${idempotencyPrefix}-proof`;
      const proofResponse = await app.inject({
        method: 'POST',
        url: `/deliveries/${deliveryId}/proofs?recipientName=Cliente%20Smoke&publicVisible=true`,
        headers: { ...courierHeaders, 'idempotency-key': proofKey,
          'content-type': `multipart/form-data; boundary=${multipart.boundary}` },
        payload: multipart.payload,
      });
      const proof = body<ProofBody>(proofResponse, 201, 'armazenar comprovante');
      if (proof.mimeType !== 'image/png' || proof.recipientName !== 'Cliente Smoke') {
        throw new Error('Metadados do comprovante inesperados.');
      }
      const proofReplay = await app.inject({
        method: 'POST',
        url: `/deliveries/${deliveryId}/proofs?recipientName=Cliente%20Smoke&publicVisible=true`,
        headers: { ...courierHeaders, 'idempotency-key': proofKey,
          'content-type': `multipart/form-data; boundary=${multipart.boundary}` },
        payload: multipart.payload,
      });
      if (proofReplay.statusCode !== 201 || proofReplay.headers['idempotency-replayed'] !== 'true') {
        throw new Error('O upload do comprovante não preservou idempotência.');
      }
    }
  }

  if (!backgroundSessionId || !backgroundSessionToken) {
    throw new Error('A sessão de rastreamento nativo não foi criada.');
  }
  const inactiveNative = await app.inject({
    method: 'POST',
    url: '/mobile/location',
    headers: { authorization: `Bearer ${backgroundSessionToken}` },
    payload: {
      latitude: -23.5619, longitude: -46.6554, accuracy: 8,
      altitude: null, bearing: 130, speed: 0, time: Date.now(), source: 'native',
    },
  });
  if (inactiveNative.statusCode !== 422) {
    throw new Error(`Sessão nativa deveria parar de autorizar após a entrega: HTTP ${inactiveNative.statusCode}.`);
  }
  body<{ revoked: boolean }>(await app.inject({
    method: 'DELETE',
    url: `/courier/background-tracking-sessions/${backgroundSessionId}`,
    headers: courierHeaders,
  }), 200, 'revogar rastreamento nativo');
  const revokedNative = await app.inject({
    method: 'POST',
    url: '/mobile/location',
    headers: { authorization: `Bearer ${backgroundSessionToken}` },
    payload: {
      latitude: -23.5619, longitude: -46.6554, accuracy: 8,
      altitude: null, bearing: 130, speed: 0, time: Date.now(), source: 'native',
    },
  });
  if (revokedNative.statusCode !== 401) {
    throw new Error(`Credencial nativa revogada ainda foi aceita: HTTP ${revokedNative.statusCode}.`);
  }

  const detail = body<EntityBody>(await app.inject({
    method: 'GET', url: `/deliveries/${deliveryId}`, headers,
  }), 200, 'consultar histÃ³rico');
  const timeline = detail.history?.map((entry) => entry.toStatus) ?? [];
  const expectedTimeline = [
    'AWAITING_COURIER', 'ASSIGNED', 'AWAITING_PICKUP', 'COLLECTED', 'IN_ROUTE', 'DELIVERED',
  ];
  if (JSON.stringify(timeline) !== JSON.stringify(expectedTimeline)) {
    throw new Error(`HistÃ³rico inesperado: ${JSON.stringify(timeline)}`);
  }

  const deliveredPublic = body<PublicTrackingBody>(await app.inject({
    method: 'GET', url: `/public/tracking/${activeToken}`,
  }), 200, 'acompanhar entrega concluída');
  if (deliveredPublic.status !== 'DELIVERED' || deliveredPublic.history.length !== expectedTimeline.length) {
    throw new Error('A consulta pública não refletiu a conclusão e sua linha do tempo.');
  }
  if (!deliveredPublic.proof.available || deliveredPublic.proof.recipientName !== 'Cliente Smoke') {
    throw new Error('O comprovante autorizado não apareceu após a conclusão.');
  }
  const publicProof = await app.inject({ method: 'GET', url: `/public/tracking/${activeToken}/proof` });
  if (publicProof.statusCode !== 200 || !publicProof.headers['content-type']?.startsWith('image/png')) {
    throw new Error('O arquivo do comprovante público não foi protegido pelo token da entrega.');
  }

  const queuedMessage = body<MessageBody>(await app.inject({
    method: 'POST', url: `/deliveries/${deliveryId}/tracking-message`,
    headers: { ...headers, 'idempotency-key': `${idempotencyPrefix}-message` },
    payload: { channel: 'WHATSAPP' },
  }), 202, 'enfileirar mensagem de acompanhamento');
  if (queuedMessage.status !== 'PENDING') throw new Error('A mensagem não entrou na fila.');
  const workerDatabase = createPool(smokeEnv);
  try {
    const workerResult = await processNotificationBatch(workerDatabase, smokeEnv, 25);
    if (!workerResult.processed) throw new Error('O worker não processou eventos do outbox.');
  } finally {
    await workerDatabase.end();
  }
  let messages = body<{ data: MessageBody[] }>(await app.inject({
    method: 'GET', url: `/deliveries/${deliveryId}/messages`, headers,
  }), 200, 'consultar histórico de mensagens');
  const sentMessage = messages.data.find((item) => item.id === queuedMessage.id);
  if (sentMessage?.status !== 'SENT' || !sentMessage.providerMessageId) {
    throw new Error(`Mensagem não foi processada: ${JSON.stringify(sentMessage)}.`);
  }
  const webhookPayload = {
    entry: [{ changes: [{ value: { statuses: [{
      id: sentMessage.providerMessageId, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)),
    }] } }] }],
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    body<{ received: boolean }>(await app.inject({
      method: 'POST', url: '/webhooks/whatsapp', payload: webhookPayload,
    }), 200, 'processar callback idempotente');
  }
  messages = body<{ data: MessageBody[] }>(await app.inject({
    method: 'GET', url: `/deliveries/${deliveryId}/messages`, headers,
  }), 200, 'confirmar entrega da mensagem');
  if (messages.data.find((item) => item.id === queuedMessage.id)?.status !== 'DELIVERED') {
    throw new Error('O callback não atualizou a entrega da mensagem.');
  }
  const secrecyDatabase = createPool(smokeEnv);
  try {
    const stored = await secrecyDatabase.query<{ encrypted_payload: string }>(
      'SELECT encrypted_payload FROM rastreia.message_deliveries WHERE id = $1', [queuedMessage.id],
    );
    if (stored.rows[0]?.encrypted_payload.includes('/rastrear/')) {
      throw new Error('O link público foi persistido em texto puro na mensagem.');
    }
  } finally {
    await secrecyDatabase.end();
  }

  body<{ revoked: boolean }>(await app.inject({
    method: 'POST', url: `/deliveries/${deliveryId}/tracking-link/revoke`, headers,
  }), 200, 'revogar link público');
  const revokedResponse = await app.inject({ method: 'GET', url: `/public/tracking/${activeToken}` });
  const unknownResponse = await app.inject({ method: 'GET', url: `/public/tracking/${'A'.repeat(43)}` });
  if (revokedResponse.statusCode !== 404 || unknownResponse.statusCode !== 404
      || revokedResponse.body !== unknownResponse.body) {
    throw new Error('Tokens revogado e inexistente produziram respostas distinguíveis.');
  }

  const expiringLink = body<TrackingLinkBody>(await app.inject({
    method: 'POST', url: `/deliveries/${deliveryId}/tracking-link`, headers,
  }), 200, 'emitir link para teste de expiração');
  const expiringToken = tokenFrom(expiringLink.url);
  const expiryDatabase = createPool(env);
  try {
    await expiryDatabase.query(
      `UPDATE rastreia.tracking_tokens
       SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
       WHERE token_hash = $1`,
      [trackingTokenHash(expiringToken, env.TRACKING_TOKEN_PEPPER)],
    );
  } finally {
    await expiryDatabase.end();
  }
  const expiredResponse = await app.inject({ method: 'GET', url: `/public/tracking/${expiringToken}` });
  if (expiredResponse.statusCode !== 404 || expiredResponse.body !== unknownResponse.body) {
    throw new Error('Token expirado produziu uma resposta distinguível.');
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    apiRole: runtimeCheck.current_role,
    visibleTenants: Number(runtimeCheck.visible_tenants),
    foreignTenantHidden: true,
    courierRoleEnforced: true,
    idempotencyReplay: true,
    publicTrackingIsolated: true,
    tokenReissueAndRevocation: true,
    expiredTokenIndistinguishable: true,
    locationIdempotency: true,
    backgroundTrackingScopedToken: true,
    nativeQueueDeduplication: true,
    backgroundTrackingRevocation: true,
    batchQualityFilter: true,
    realtimeScopes: true,
    publicLocationStateGate: true,
    proofStoredOutsideDatabase: true,
    proofIdempotencyAndPublicGate: true,
    encryptedMessageOutbox: true,
    messageCallbackIdempotency: true,
    multiplePushDevices: true,
    finalStatus: detail.status,
    timeline,
  }, null, 2)}\n`);
} finally {
  await app.close();
  const cleanup = createPool(env);
  try {
    await withTransaction(cleanup, async (client) => {
      if (courierId) {
        const user = await client.query<{ user_id: string }>(
          'SELECT user_id FROM rastreia.courier_profiles WHERE id = $1', [courierId],
        );
        courierUserId = user.rows[0]?.user_id;
      }
      if (deliveryId) {
        const proofKeys = await client.query<{ object_key: string }>(
          'SELECT object_key FROM rastreia.delivery_proofs WHERE delivery_id = $1', [deliveryId],
        );
        proofObjectKeys.push(...proofKeys.rows.map((row) => row.object_key));
        await client.query(
          `DELETE FROM rastreia.message_webhook_receipts receipt
           USING rastreia.message_deliveries message
           WHERE message.delivery_id = $1 AND receipt.tenant_id = message.tenant_id
             AND receipt.provider_event_id LIKE message.provider_message_id || ':%'`, [deliveryId],
        );
        await client.query(
          `DELETE FROM rastreia.notification_attempts
           WHERE message_delivery_id IN (SELECT id FROM rastreia.message_deliveries WHERE delivery_id = $1)`,
          [deliveryId],
        );
        await client.query(
          `DELETE FROM rastreia.outbox_events
           WHERE aggregate_id IN (SELECT id FROM rastreia.message_deliveries WHERE delivery_id = $1)`,
          [deliveryId],
        );
        await client.query('DELETE FROM rastreia.message_deliveries WHERE delivery_id = $1', [deliveryId]);
        await client.query('DELETE FROM rastreia.delivery_proofs WHERE delivery_id = $1', [deliveryId]);
        await client.query('DELETE FROM rastreia.background_tracking_sessions WHERE delivery_id = $1', [deliveryId]);
        await client.query('DELETE FROM rastreia.location_points WHERE delivery_id = $1', [deliveryId]);
        await client.query('DELETE FROM rastreia.courier_last_locations WHERE delivery_id = $1', [deliveryId]);
        await client.query('DELETE FROM rastreia.location_event_receipts WHERE delivery_id = $1', [deliveryId]);
        await client.query('DELETE FROM rastreia.tracking_tokens WHERE delivery_id = $1', [deliveryId]);
        await client.query('DELETE FROM rastreia.delivery_status_history WHERE delivery_id = $1', [deliveryId]);
        await client.query('DELETE FROM rastreia.outbox_events WHERE aggregate_id = $1', [deliveryId]);
        await client.query('DELETE FROM rastreia.deliveries WHERE id = $1', [deliveryId]);
      }
      await client.query('DELETE FROM rastreia.idempotency_keys WHERE idempotency_key LIKE $1', [`${idempotencyPrefix}%`]);
      const entityIds = [storeId, courierId, deliveryId, backgroundSessionId]
        .filter((id): id is string => Boolean(id));
      if (entityIds.length) {
        await client.query('DELETE FROM rastreia.audit_logs WHERE entity_id = ANY($1::uuid[])', [entityIds]);
      }
      if (courierId) {
        await client.query('DELETE FROM rastreia.courier_store_links WHERE courier_profile_id = $1', [courierId]);
        await client.query('DELETE FROM rastreia.courier_profiles WHERE id = $1', [courierId]);
      }
      if (courierUserId) {
        await client.query('DELETE FROM rastreia.tenant_users WHERE user_id = $1', [courierUserId]);
        await client.query('DELETE FROM rastreia.users WHERE id = $1', [courierUserId]);
      }
      if (storeId) await client.query('DELETE FROM rastreia.stores WHERE id = $1', [storeId]);
      if (sessionIds.length) await client.query('DELETE FROM rastreia.refresh_sessions WHERE id = ANY($1::uuid[])', [sessionIds]);
      await client.query('DELETE FROM rastreia.tenants WHERE id = $1', [foreignTenantId]);
    });
  } finally {
    await cleanup.end();
  }
  const storage = new LocalObjectStorage(smokeEnv.OBJECT_STORAGE_PATH);
  for (const key of proofObjectKeys) await storage.remove(key);
}
