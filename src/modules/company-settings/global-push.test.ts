import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../config/env.js';
import { resolveCompanyService } from './company-settings.service.js';

describe('global VAPID identity',()=>{
  it('never loads legacy per-company VAPID overrides',async()=>{
    const query=vi.fn();
    const env={PUSH_VAPID_SUBJECT:'mailto:test@example.test',PUSH_VAPID_PUBLIC_KEY:'test-public',PUSH_VAPID_PRIVATE_KEY:'test-private'} as AppEnv;
    const result=await resolveCompanyService({query},env,'company','WEB_PUSH');
    expect(query).not.toHaveBeenCalled();expect(result.source).toBe('environment');
    expect(result.values['publicKey']).toBe('test-public');expect(result.enabled).toBe(true);
  });
});
