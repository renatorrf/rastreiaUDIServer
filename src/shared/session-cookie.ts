import type { AppEnv } from '../config/env.js';

export function sessionCookieOptions(
  env: AppEnv,
  path: string,
  localSameSite: 'lax' | 'strict' = 'lax',
) {
  return {
    path,
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SECURE ? 'none' as const : localSameSite,
    maxAge: env.REFRESH_TOKEN_TTL_SECONDS,
  };
}
