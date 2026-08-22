import { describe, expect, it } from 'vitest';
import { retryDelaySeconds } from '../src/workers/notification-worker.service.js';

describe('retentativa do outbox', () => {
  it('aplica backoff exponencial determinístico com jitter limitado', () => {
    const eventId = '9dc90aa6-b35b-496a-8d5f-9f43eddb90df';
    const first = retryDelaySeconds(1, eventId, 30, 3600);
    const second = retryDelaySeconds(2, eventId, 30, 3600);
    expect(first).toBeGreaterThanOrEqual(30);
    expect(first).toBeLessThanOrEqual(38);
    expect(second).toBeGreaterThanOrEqual(60);
    expect(second).toBeLessThanOrEqual(75);
    expect(retryDelaySeconds(2, eventId, 30, 3600)).toBe(second);
  });

  it('respeita o teto configurado', () => {
    expect(retryDelaySeconds(20, 'event', 30, 3600)).toBe(3600);
  });
});
