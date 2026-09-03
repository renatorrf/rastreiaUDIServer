import { randomUUID } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { authenticatePlatform } from './auth.guard.js';
import { createTokenPair } from './token.service.js';

describe('platform authentication boundary',()=>{
  const env={JWT_ACCESS_SECRET:'test-only-access-secret-with-32-characters',JWT_ACCESS_SECRET_PREVIOUS:'',
    JWT_REFRESH_SECRET:'test-only-refresh-secret-with-32-characters',JWT_REFRESH_SECRET_PREVIOUS:'',ACCESS_TOKEN_TTL_SECONDS:300,REFRESH_TOKEN_TTL_SECONDS:3600} as AppEnv;
  it('returns 403 for a valid tenant token instead of reporting it as unauthenticated',async()=>{
    const tokens=await createTokenPair(env,{userId:randomUUID(),tenantId:randomUUID(),role:'TENANT_MANAGER',storeIds:[]});
    const request={headers:{authorization:`Bearer ${tokens.accessToken}`}};
    await expect(authenticatePlatform(env,{} as Database)(request as never)).rejects.toMatchObject({statusCode:403,code:'FORBIDDEN'});
  });
  it('keeps missing and invalid credentials as 401',async()=>{
    await expect(authenticatePlatform(env,{} as Database)({headers:{}} as never)).rejects.toMatchObject({statusCode:401});
    await expect(authenticatePlatform(env,{} as Database)({headers:{authorization:'Bearer invalid'}} as never)).rejects.toMatchObject({statusCode:401});
  });
});
