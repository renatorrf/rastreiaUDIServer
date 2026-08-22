import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/config/env.js';
import { enforceRetentionPolicies } from '../src/workers/retention.service.js';

describe('retenção', () => {
  it('não toca no banco antes da aprovação explícita', async () => {
    const connect = vi.fn();
    const database = { connect };
    const result = await enforceRetentionPolicies(database as never, {
      RETENTION_ENABLED: false,
    } as AppEnv);
    expect(result.ran).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });
});
