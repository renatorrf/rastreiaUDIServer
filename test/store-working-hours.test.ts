import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../src/modules/auth/auth.types.js';
import {
  canManageStoreWorkingHours, storeWorkingHoursSchema,
} from '../src/modules/stores/store.routes.js';

const storeId = '10000000-0000-4000-8000-000000000001';

function auth(role: AuthContext['role'], storeIds: string[] = []): AuthContext {
  return {
    tenantId: '20000000-0000-4000-8000-000000000001',
    userId: '30000000-0000-4000-8000-000000000001',
    sessionId: '40000000-0000-4000-8000-000000000001',
    role,
    storeIds,
  };
}

describe('store working-hours autonomy', () => {
  it('accepts complete weekly hours and overnight shifts', () => {
    expect(storeWorkingHoursSchema.parse({
      openingTime: '18:00',
      closingTime: '02:00',
      operatingWeekdays: [1, 2, 3, 4, 5],
      updatedAt: '2026-09-04T12:00:00.000Z',
    })).toMatchObject({ openingTime: '18:00', closingTime: '02:00' });
  });

  it('rejects incomplete or equal hours', () => {
    expect(storeWorkingHoursSchema.safeParse({
      openingTime: '08:00', closingTime: null, operatingWeekdays: [1],
      updatedAt: '2026-09-04T12:00:00.000Z',
    }).success).toBe(false);
    expect(storeWorkingHoursSchema.safeParse({
      openingTime: '08:00', closingTime: '08:00', operatingWeekdays: [1],
      updatedAt: '2026-09-04T12:00:00.000Z',
    }).success).toBe(false);
  });

  it('limits operators to linked stores and never grants couriers access', () => {
    expect(canManageStoreWorkingHours(auth('TENANT_MANAGER'), storeId)).toBe(true);
    expect(canManageStoreWorkingHours(auth('STORE_OPERATOR', [storeId]), storeId)).toBe(true);
    expect(canManageStoreWorkingHours(auth('STORE_OPERATOR'), storeId)).toBe(false);
    expect(canManageStoreWorkingHours(auth('COURIER', [storeId]), storeId)).toBe(false);
  });
});
