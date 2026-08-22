import crypto from 'node:crypto';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import type { AppEnv } from '../../config/env.js';

// Os cinco objetos vazios são os parâmetros genéricos exigidos pelo tipo concreto criado por node-redis.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type RedisClient = RedisClientType<{}, {}, {}, 3, {}>;
export type RedisDependencyStatus = 'disabled' | 'ready' | 'unavailable';

type RedisLog = (level: 'info' | 'warn', message: string, details?: Record<string, unknown>) => void;

const unlockScript = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

export class RedisRuntime {
  constructor(
    private readonly configured: boolean,
    private readonly required: boolean,
    private readonly prefix: string,
    private readonly connection: RedisClient | null,
    private readonly log?: RedisLog,
  ) {}

  get client(): RedisClient | null {
    return this.connection?.isReady ? this.connection : null;
  }

  get status(): RedisDependencyStatus {
    if (!this.configured) return this.required ? 'unavailable' : 'disabled';
    return this.connection?.isReady ? 'ready' : 'unavailable';
  }

  get isRequired(): boolean {
    return this.required;
  }

  key(suffix: string): string {
    return `${this.prefix}${suffix}`;
  }

  async ping(): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    try {
      return await client.ping() === 'PONG';
    } catch (error) {
      this.log?.('warn', 'Redis não respondeu ao ping.', { error: (error as Error).message });
      return false;
    }
  }

  async duplicate(): Promise<RedisClient | null> {
    if (!this.connection?.isReady) return null;
    const duplicate = this.connection.duplicate();
    duplicate.on('error', (error) => {
      this.log?.('warn', 'Conexão Redis auxiliar indisponível.', { error: error.message });
    });
    try {
      await duplicate.connect();
      return duplicate;
    } catch (error) {
      duplicate.destroy();
      this.log?.('warn', 'Falha ao abrir conexão Redis auxiliar.', { error: (error as Error).message });
      return null;
    }
  }

  async acquireLease(name: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
    const client = this.client;
    if (!client) return null;
    const key = this.key(`lease:${name}`);
    const token = crypto.randomUUID();
    try {
      const acquired = await client.set(key, token, { NX: true, PX: ttlMs });
      if (acquired !== 'OK') return null;
      return async () => {
        try {
          await client.eval(unlockScript, { keys: [key], arguments: [token] });
        } catch (error) {
          this.log?.('warn', 'Não foi possível liberar a trava Redis.', { error: (error as Error).message });
        }
      };
    } catch (error) {
      this.log?.('warn', 'Redis indisponível para coordenação distribuída.', { error: (error as Error).message });
      return null;
    }
  }

  async close(): Promise<void> {
    if (!this.connection?.isOpen) return;
    this.connection.destroy();
  }
}

export async function createRedisRuntime(env: AppEnv, log?: RedisLog): Promise<RedisRuntime> {
  const url = env.REDIS_URL.trim();
  const prefix = env.REDIS_KEY_PREFIX.endsWith(':') ? env.REDIS_KEY_PREFIX : `${env.REDIS_KEY_PREFIX}:`;
  if (!url) return new RedisRuntime(false, env.REDIS_REQUIRED, prefix, null, log);

  let connectedOnce = false;
  const client = createClient({
    url,
    socket: {
      connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries) => {
        if (!connectedOnce && retries >= 3) return false;
        return Math.min(100 * 2 ** Math.min(retries, 6), 5_000);
      },
    },
  });
  client.on('ready', () => {
    connectedOnce = true;
  });
  client.on('error', (error) => {
    log?.('warn', 'Conexão Redis indisponível.', { error: error.message });
  });
  try {
    await client.connect();
    log?.('info', 'Redis conectado.', { prefix });
    return new RedisRuntime(true, env.REDIS_REQUIRED, prefix, client, log);
  } catch (error) {
    client.destroy();
    log?.('warn', 'Aplicação iniciada em modo degradado sem Redis.', { error: (error as Error).message });
    return new RedisRuntime(true, env.REDIS_REQUIRED, prefix, null, log);
  }
}
