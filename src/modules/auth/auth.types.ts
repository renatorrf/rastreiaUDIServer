export const tenantRoles = ['TENANT_MANAGER', 'STORE_OPERATOR', 'COURIER'] as const;
export type TenantRole = (typeof tenantRoles)[number];

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: TenantRole;
  storeIds: string[];
  sessionId: string;
}

export interface PlatformAuthContext {
  userId: string;
  role: 'PLATFORM_ADMIN';
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
    platformAuth: PlatformAuthContext;
  }
}
