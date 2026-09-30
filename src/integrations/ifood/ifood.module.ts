import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import type { ExternalOrderProvider } from '../external-orders/external-order-provider.js';
import { IfoodClient } from './ifood.client.js';
import { IfoodProvider } from './ifood.provider.js';
import { MockIfoodProvider } from './ifood.mock.js';
import { resolveCompanyService,companyServiceConfigured,type ResolvedCompanyService } from '../../modules/company-settings/company-settings.service.js';
export function integrationSecret(env: AppEnv): string { return env.MESSAGE_PAYLOAD_SECRET || env.TRACKING_TOKEN_PEPPER; }
export function createIfoodProvider(db: Database, env: AppEnv): ExternalOrderProvider {
  return env.IFOOD_MODE === 'mock' ? new MockIfoodProvider(db, integrationSecret(env)) : new IfoodProvider(new IfoodClient(env));
}

export async function ifoodConfigForCompany(db:Database,env:AppEnv,companyId:string):Promise<ResolvedCompanyService>{
  return resolveCompanyService(db,env,companyId,'IFOOD');
}

export async function createIfoodProviderForCompany(
  db:Database,env:AppEnv,companyId:string,connectionMode?:string,
):Promise<ExternalOrderProvider>{
  const service=await ifoodConfigForCompany(db,env,companyId);
  if(!companyServiceConfigured(service))throw new Error('IFOOD_COMPANY_NOT_CONFIGURED');
  const mode=connectionMode??String(service.values['mode']??env.IFOOD_MODE);
  if(mode==='mock')return new MockIfoodProvider(db,integrationSecret(env));
  return new IfoodProvider(new IfoodClient({
    ...env,
    IFOOD_BASE_URL:String(service.values['baseUrl']??env.IFOOD_BASE_URL),
    IFOOD_CLIENT_ID:String(service.values['clientId']??env.IFOOD_CLIENT_ID),
    IFOOD_CLIENT_SECRET:String(service.values['clientSecret']??env.IFOOD_CLIENT_SECRET),
    IFOOD_REQUEST_TIMEOUT_MS:Number(service.values['requestTimeoutMs']??env.IFOOD_REQUEST_TIMEOUT_MS),
  }));
}
