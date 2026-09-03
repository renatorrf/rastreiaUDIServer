import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../database/pool.js';
import type { AppEnv } from '../../config/env.js';
import { verifyAccessToken, verifyPlatformAccessToken } from '../../modules/auth/token.service.js';
import { geoRoutes } from './geo.routes.js';
import { GeoapifyProvider } from './geoapify.provider.js';
vi.mock('../../modules/auth/token.service.js',()=>({verifyAccessToken:vi.fn(),verifyPlatformAccessToken:vi.fn()}));
let app:FastifyInstance;
const autocomplete=vi.fn();
const companyId='00000000-0000-4000-8000-000000000001';
beforeEach(async()=>{
  vi.mocked(verifyPlatformAccessToken).mockImplementation(async(_env,token)=>{if(token!=='master')throw new Error('audience');return {userId:'master-id'} as Awaited<ReturnType<typeof verifyPlatformAccessToken>>;});
  vi.mocked(verifyAccessToken).mockImplementation(async(_env,token)=>{if(token!=='operational')throw new Error('audience');return {tenantId:'tenant-id',userId:'user-id',role:'TENANT_MANAGER',storeIds:[]} as Awaited<ReturnType<typeof verifyAccessToken>>;});
  const database={connect:async()=>({release:()=>{},query:async(sql:string)=>({rows:sql.includes('FROM platform_admins')?[{active:true}]:sql.includes('tenant_session_is_current')?[{current:true}]:sql.includes('FROM stores store')?[{city:'Uberlândia',state:'MG',latitude:-18.9,longitude:-48.2}]:[]})})} as unknown as Database;
  autocomplete.mockResolvedValue([{addressLine:'Avenida Brasil',addressNumber:'2662'}]);
  app=Fastify();await geoRoutes(app,{} as AppEnv,database,{autocomplete},new GeoapifyProvider(''));
});
afterEach(async()=>{await app.close();vi.resetAllMocks();});
describe('Master geocoding route',()=>{
  it('requires Master audience, not operational or anonymous access',async()=>{
    expect((await app.inject('/platform/geo/autocomplete?q=Avenida')).statusCode).toBe(401);
    expect((await app.inject({url:'/platform/geo/autocomplete?q=Avenida',headers:{authorization:'Bearer operational'}})).statusCode).toBe(403);
    expect(autocomplete).not.toHaveBeenCalled();
  });
  it('accepts a Master with no selected store and forwards the number',async()=>{
    const response=await app.inject({url:'/platform/geo/autocomplete?q=Avenida%20Brasil%2C%202662&city=Uberl%C3%A2ndia',headers:{authorization:'Bearer master'}});
    expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
    expect(autocomplete).toHaveBeenCalledWith({query:'Avenida Brasil, 2662',city:'Uberlândia'});
    expect(response.json<{data:Array<{addressNumber:string}>}>().data[0]?.addressNumber).toBe('2662');
  });
  it('uses a company unit as geographic reference, like ADMTAXI',async()=>{
    await app.inject({url:`/platform/geo/autocomplete?q=Avenida&companyId=${companyId}`,headers:{authorization:'Bearer master'}});
    expect(autocomplete).toHaveBeenCalledWith({query:'Avenida',city:'Uberlândia, MG',latitude:-18.9,longitude:-48.2});
  });
  it('respects an explicit city instead of reusing the company reference coordinates',async()=>{
    await app.inject({url:`/platform/geo/autocomplete?q=Avenida&city=Araguari&companyId=${companyId}`,headers:{authorization:'Bearer master'}});
    expect(autocomplete).toHaveBeenCalledWith({query:'Avenida',city:'Araguari'});
  });
  it('retains the operational endpoint and reports an unavailable provider',async()=>{
    expect((await app.inject({url:'/geo/autocomplete?q=Avenida',headers:{authorization:'Bearer operational'}})).statusCode).toBe(200);
    autocomplete.mockRejectedValueOnce(new Error('GEOAPIFY_NOT_CONFIGURED'));
    expect((await app.inject({url:'/platform/geo/autocomplete?q=Avenida',headers:{authorization:'Bearer master'}})).statusCode).toBe(503);
  });
});
