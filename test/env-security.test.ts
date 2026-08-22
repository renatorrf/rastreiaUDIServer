import { afterEach, describe, expect, it } from 'vitest';
import { getEnv, resetEnvForTests } from '../src/config/env.js';

afterEach(() => resetEnvForTests());

describe('hardening da configuração', () => {
  it('rejeita configuração de produção sem TLS e segredos operacionais', () => {
    expect(() => getEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:password@database:5432/rastreia',
      APP_ORIGINS: 'http://app.example.com',
      JWT_ACCESS_SECRET: 'same-secret-with-more-than-32-characters',
      JWT_REFRESH_SECRET: 'same-secret-with-more-than-32-characters',
      TRACKING_TOKEN_PEPPER: 'same-secret-with-more-than-32-characters',
      PUBLIC_TRACKING_BASE_URL: 'http://app.example.com/rastrear',
    })).toThrow();
  });
});
