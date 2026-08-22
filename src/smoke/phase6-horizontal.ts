import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';

const apiA = process.env['API_A_URL'] ?? 'http://localhost:3101';
const apiB = process.env['API_B_URL'] ?? 'http://localhost:3102';
const gateway = process.env['GATEWAY_URL'] ?? 'http://localhost:3100';
const provider = process.env['PROVIDER_STUB_URL'] ?? 'http://localhost:3190';
const tenantSlug = process.env['BOOTSTRAP_TENANT_SLUG'] ?? 'homologacao';
const adminEmail = process.env['BOOTSTRAP_ADMIN_EMAIL'] ?? 'gestor.homologacao@example.invalid';
const adminPassword = process.env['BOOTSTRAP_ADMIN_PASSWORD'];

if (!adminPassword) throw new Error('BOOTSTRAP_ADMIN_PASSWORD ausente para o ensaio horizontal.');

interface RequestOptions {
  method?: string;
  token?: string;
  idempotencyKey?: string;
  body?: unknown;
  expected?: number[];
}

interface Entity { id: string; status?: string }
interface Login { accessToken: string }
interface TrackingLink { url: string }
interface DeadLetter { id: string; eventType: string; replayedAt: string | null }
interface Message { id: string; status: string; attemptCount: number }

async function request<T>(base: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const expected = options.expected ?? [200];
  const text = await response.text();
  if (!expected.includes(response.status)) {
    throw new Error(`${options.method ?? 'GET'} ${path}: HTTP ${response.status} - ${text.slice(0, 500)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

async function waitUntil<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
  message: string,
  timeoutMs = 25_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await operation();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${message}. Último estado: ${JSON.stringify(last)}`);
}

function waitForConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout ao conectar Socket.IO.')), 8_000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForLocation(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout aguardando broadcast entre réplicas.')), 8_000);
    socket.once('location:update', (payload: Record<string, unknown>) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

function tokenFrom(url: string): string {
  const token = new URL(url, 'http://local.test').pathname.split('/').filter(Boolean).at(-1);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Token público inválido.');
  return token;
}

async function assertReady(base: string): Promise<void> {
  const readiness = await request<{
    status: string;
    dependencies: { postgres: string; redis: string; realtime: string };
  }>(base, '/health/ready');
  if (readiness.status !== 'ready' || readiness.dependencies.postgres !== 'ready'
      || readiness.dependencies.redis !== 'ready' || readiness.dependencies.realtime !== 'redis') {
    throw new Error(`Readiness horizontal inválido em ${base}: ${JSON.stringify(readiness)}`);
  }
}

const runId = randomUUID();
const prefix = `phase6-${runId}`;
let operationsSocket: Socket | undefined;
let trackingSocket: Socket | undefined;

try {
  await Promise.all([assertReady(apiA), assertReady(apiB), assertReady(gateway)]);

  const login = await request<Login>(apiA, '/auth/login', {
    method: 'POST',
    body: { tenantSlug, email: adminEmail, password: adminPassword },
  });
  const managerToken = login.accessToken;

  const store = await request<Entity>(apiA, '/stores', {
    method: 'POST', token: managerToken,
    body: {
      name: `Loja Homologação ${runId.slice(0, 8)}`,
      externalReference: prefix,
      addressLine: 'Avenida Paulista', addressNumber: '1000', neighborhood: 'Bela Vista',
      city: 'São Paulo', state: 'SP', postalCode: '01310-100',
      latitude: -23.561414, longitude: -46.655881, addressConfidence: 1,
    },
    expected: [201],
  });

  const courierEmail = `${prefix}@example.invalid`;
  const courierPassword = `Phase6-${runId}-safe`;
  const courier = await request<Entity>(apiB, '/couriers', {
    method: 'POST', token: managerToken,
    body: {
      name: 'Entregador Homologação', email: courierEmail, password: courierPassword,
      phone: '+5511999999999', vehicleType: 'MOTORCYCLE', storeIds: [store.id],
    },
    expected: [201],
  });

  const delivery = await request<Entity>(apiA, '/deliveries', {
    method: 'POST', token: managerToken, idempotencyKey: `${prefix}-delivery`,
    body: {
      storeId: store.id, externalReference: prefix, recipientName: 'Cliente Homologação',
      recipientPhone: '+5511988888888', addressLine: 'Rua Vergueiro', addressNumber: '100',
      neighborhood: 'Liberdade', city: 'São Paulo', state: 'SP', postalCode: '01504-000',
      latitude: -23.5733, longitude: -46.6404, addressConfidence: 1,
    },
    expected: [201],
  });
  const link = await request<TrackingLink>(apiB, `/deliveries/${delivery.id}/tracking-link`, {
    method: 'POST', token: managerToken,
  });
  const publicToken = tokenFrom(link.url);
  await request<Entity>(apiA, `/deliveries/${delivery.id}/assign`, {
    method: 'POST', token: managerToken, idempotencyKey: `${prefix}-assign`,
    body: { courierId: courier.id },
  });

  const courierLogin = await request<Login>(apiB, '/auth/login', {
    method: 'POST', body: { tenantSlug, email: courierEmail, password: courierPassword },
  });
  for (const action of ['collect', 'start']) {
    await request<Entity>(apiB, `/deliveries/${delivery.id}/${action}`, {
      method: 'POST', token: courierLogin.accessToken, idempotencyKey: `${prefix}-${action}`,
    });
  }

  operationsSocket = io(`${apiA}/operations`, {
    auth: { accessToken: managerToken }, transports: ['websocket'], forceNew: true,
  });
  trackingSocket = io(`${apiB}/tracking`, {
    auth: { token: publicToken }, transports: ['websocket'], forceNew: true,
  });
  await Promise.all([waitForConnect(operationsSocket), waitForConnect(trackingSocket)]);
  const operationsEvent = waitForLocation(operationsSocket);
  const trackingEvent = waitForLocation(trackingSocket);
  await request(apiA, '/courier/location', {
    method: 'POST', token: courierLogin.accessToken, idempotencyKey: `${prefix}-location`,
    body: {
      eventId: randomUUID(), deliveryId: delivery.id, latitude: -23.5617, longitude: -46.6556,
      accuracy: 9, speed: 5, heading: 125, capturedAt: new Date().toISOString(),
    },
    expected: [202],
  });
  const [internalPayload, publicPayload] = await Promise.all([operationsEvent, trackingEvent]);
  if (internalPayload['deliveryId'] !== delivery.id || 'deliveryId' in publicPayload) {
    throw new Error('Broadcast horizontal não preservou o escopo dos payloads.');
  }

  await request(provider, '/mode/fail', { method: 'PUT' });
  const queued = await request<{ id: string }>(apiA, `/deliveries/${delivery.id}/tracking-message`, {
    method: 'POST', token: managerToken, idempotencyKey: `${prefix}-message`,
    body: { channel: 'SMS' }, expected: [202],
  });
  const deadLetters = await waitUntil(
    () => request<{ data: DeadLetter[] }>(apiB, '/operations/dead-letters?limit=25', { token: managerToken }),
    (result) => result.data.some((item) => item.eventType === 'communication.tracking.requested'),
    'Evento não alcançou a DLQ após falhas e backoff',
  );
  const deadLetter = deadLetters.data.find((item) => item.eventType === 'communication.tracking.requested')!;
  await request(provider, '/mode/success', { method: 'PUT' });
  await request(apiB, `/operations/dead-letters/${deadLetter.id}/replay`, {
    method: 'POST', token: managerToken,
  });
  const messages = await waitUntil(
    () => request<{ data: Message[] }>(apiA, `/deliveries/${delivery.id}/messages`, { token: managerToken }),
    (result) => result.data.some((message) => message.id === queued.id && message.status === 'SENT'),
    'Replay da DLQ não foi entregue pelo provedor recuperado',
  );
  const delivered = messages.data.find((message) => message.id === queued.id)!;
  const providerState = await request<{ accepted: number; rejected: number }>(provider, '/state');
  if (providerState.accepted !== 1 || providerState.rejected < 3) {
    throw new Error(`Workers concorrentes produziram contagem inesperada: ${JSON.stringify(providerState)}`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    runId,
    checks: {
      replicasReady: 2,
      gatewayReady: true,
      socketBroadcastAcrossReplicas: true,
      payloadScopesPreserved: true,
      deadLetterCreated: true,
      deadLetterReplayed: true,
      providerRecovered: true,
      singleDeliveryAfterReplay: providerState.accepted === 1,
      rejectedProviderAttempts: providerState.rejected,
      attemptsBeforeSuccess: delivered.attemptCount,
    },
  }, null, 2)}\n`);
} finally {
  operationsSocket?.disconnect();
  trackingSocket?.disconnect();
  await fetch(`${provider}/mode/success`, { method: 'PUT' }).catch(() => undefined);
}
