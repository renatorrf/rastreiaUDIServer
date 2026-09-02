import type { AppEnv } from '../../config/env.js';

export class IfoodHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterSeconds = 0) { super(status ? `IFOOD_HTTP_${status}` : 'IFOOD_TIMEOUT_OR_NETWORK'); }
}
export class IfoodAuthService {
  private token = '';
  private expiresAt = 0;
  private pending: Promise<string> | undefined;
  constructor(private readonly env: AppEnv, private readonly http: typeof fetch = fetch) {}
  invalidate(token: string): void { if (this.token === token) this.expiresAt = 0; }
  async getAccessToken(): Promise<string> {
    if (this.token && this.expiresAt > Date.now()) return this.token;
    this.pending ??= this.obtain().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async obtain(): Promise<string> {
    let response: Response;
    try {
      response = await this.http(`${this.env.IFOOD_BASE_URL}/authentication/v1.0/oauth/token`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grantType: 'client_credentials', clientId: this.env.IFOOD_CLIENT_ID, clientSecret: this.env.IFOOD_CLIENT_SECRET }),
        signal: AbortSignal.timeout(this.env.IFOOD_REQUEST_TIMEOUT_MS),
      });
    } catch { throw new IfoodHttpError(0); }
    if (!response.ok) throw new IfoodHttpError(response.status);
    const body = await response.json() as { accessToken?: unknown; expiresIn?: unknown };
    if (typeof body.accessToken !== 'string' || !Number.isFinite(Number(body.expiresIn)) || Number(body.expiresIn) <= 0) throw new Error('IFOOD_AUTH_INVALID_RESPONSE');
    this.token = body.accessToken;
    this.expiresAt = Date.now() + Math.max(1, Number(body.expiresIn) - 60) * 1000;
    return this.token;
  }
}

export class IfoodClient {
  readonly auth: IfoodAuthService;
  constructor(private readonly env: AppEnv, private readonly http: typeof fetch = fetch) { this.auth = new IfoodAuthService(env, http); }
  async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, refreshed = false): Promise<unknown> {
    const token = await this.auth.getAccessToken();
    let response: Response;
    try {
      response = await this.http(`${this.env.IFOOD_BASE_URL}${path}`, {
        method, redirect: 'error', headers: { ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(this.env.IFOOD_REQUEST_TIMEOUT_MS),
      });
    } catch { throw new IfoodHttpError(0); }
    if (response.status === 401 && !refreshed) { this.auth.invalidate(token); return this.request(path, method, body, headers, true); }
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const delay = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? Math.max(0, (Date.parse(retry) - Date.now()) / 1000) : 0;
      throw new IfoodHttpError(response.status, Math.min(3600, Number.isFinite(delay) ? delay : 0));
    }
    const text = await response.text();
    return text ? JSON.parse(text) as unknown : null;
  }
}
