import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import type { ExternalOrderProvider } from '../external-orders/external-order-provider.js';
import { IfoodClient } from './ifood.client.js';
import { IfoodProvider } from './ifood.provider.js';
import { MockIfoodProvider } from './ifood.mock.js';
export function integrationSecret(env: AppEnv): string { return env.MESSAGE_PAYLOAD_SECRET || env.TRACKING_TOKEN_PEPPER; }
export function createIfoodProvider(db: Database, env: AppEnv): ExternalOrderProvider {
  return env.IFOOD_MODE === 'mock' ? new MockIfoodProvider(db, integrationSecret(env)) : new IfoodProvider(new IfoodClient(env));
}
