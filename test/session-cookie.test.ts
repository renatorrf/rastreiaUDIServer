import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/config/env.js';
import { sessionCookieOptions } from '../src/shared/session-cookie.js';

function env(secure: boolean): AppEnv {
  return { COOKIE_SECURE: secure, REFRESH_TOKEN_TTL_SECONDS: 3600 } as AppEnv;
}

describe('session cookie options', () => {
  it('permite renovação entre o WebView HTTPS e a API HTTPS', () => {
    expect(sessionCookieOptions(env(true), '/auth')).toMatchObject({
      path: '/auth', httpOnly: true, secure: true, sameSite: 'none', maxAge: 3600,
    });
  });

  it('mantém SameSite restritivo quando cookies seguros não estão habilitados', () => {
    expect(sessionCookieOptions(env(false), '/auth').sameSite).toBe('lax');
    expect(sessionCookieOptions(env(false), '/platform/auth', 'strict').sameSite).toBe('strict');
  });
});
