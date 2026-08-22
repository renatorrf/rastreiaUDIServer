import { describe, expect, it, vi } from 'vitest';
import { listRoutes } from '../src/modules/routes/route.service.js';

describe('route list query', () => {
  it('numera os parâmetros do escopo sem deixar placeholder sem tipo', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM routes route')) return { rows: [] };
      if (sql.includes('FROM route_stops')) return { rows: [] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const database = { connect: vi.fn().mockResolvedValue(client) };

    await listRoutes(database as never, {
      tenantId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      sessionId: '33333333-3333-4333-8333-333333333333',
      role: 'TENANT_MANAGER', storeIds: [],
    });

    const routeQuery = query.mock.calls.find(([sql]) => sql.includes('FROM routes route'));
    expect(routeQuery?.[1]).toEqual(['TENANT_MANAGER', [], '22222222-2222-4222-8222-222222222222']);
    expect(routeQuery?.[0]).toContain("$1::text = 'TENANT_MANAGER'");
  });
});
