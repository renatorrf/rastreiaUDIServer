import { describe, expect, it } from 'vitest';
import { prepareCloudRunWorker } from '../src/deployment/cloud-run-worker.js';

const sample = [
  'DATABASE_URL=postgresql://example:example@localhost:5432/example',
  'JWT_ACCESS_SECRET=access-test-123456789012345678901234567890',
  'JWT_REFRESH_SECRET=refresh-test-123456789012345678901234567890',
  'TRACKING_TOKEN_PEPPER=pepper-test-123456789012345678901234567890',
].join('\n');

describe('local Cloud Run worker export', () => {
  it('keeps the pool paused with its own entrypoint and only infrastructure placeholders', () => {
    const { yaml, variableCount } = prepareCloudRunWorker(sample);
    expect(yaml).toContain("run.googleapis.com/manualInstanceCount: '0'");
    expect(yaml).toContain('kind: WorkerPool');
    expect(yaml).toContain("args: ['dist/workers/notification-worker.js']");
    expect(yaml.match(/__[A-Z0-9_]+__/g)).toEqual([
      '__WORKER_SERVICE_ACCOUNT_EMAIL__', '__BACKEND_IMAGE_WITH_SHA256_DIGEST__',
    ]);
    expect(yaml).not.toContain('dist/server.js');
    expect(variableCount).toBeGreaterThan(50);
  });

  it('materializes defaults including NODE_ENV without enabling iFood or changing keys', () => {
    const { yaml } = prepareCloudRunWorker(sample);
    expect(yaml).toContain('name: NODE_ENV\n              value: "development"');
    expect(yaml).toContain('name: IFOOD_ENABLED\n              value: "false"');
    expect(yaml).not.toContain('MASTER_ACCESS_TOKEN');
    expect(yaml).toContain('name: MESSAGE_PAYLOAD_SECRET\n              value: ""');
    expect(yaml).toContain('value: "pepper-test-123456789012345678901234567890"');
  });

  it('preserves sandbox/webhook settings and the existing payload key', () => {
    const { yaml } = prepareCloudRunWorker(`${sample}\nIFOOD_ENABLED=true\nIFOOD_MODE=sandbox\nIFOOD_EVENTS_MODE=webhook\nIFOOD_CLIENT_ID=test-client\nIFOOD_CLIENT_SECRET=test-secret\nMESSAGE_PAYLOAD_SECRET=existing-payload-secret\nREDIS_KEY_PREFIX=test-prefix`);
    expect(yaml).toContain('name: IFOOD_MODE\n              value: "sandbox"');
    expect(yaml).toContain('name: IFOOD_EVENTS_MODE\n              value: "webhook"');
    expect(yaml).toContain('name: MESSAGE_PAYLOAD_SECRET\n              value: "existing-payload-secret"');
    expect(yaml).toContain('name: REDIS_KEY_PREFIX\n              value: "test-prefix"');
  });

  it('does not export bootstrap passwords, HTTP ports or arbitrary environment keys', () => {
    const { yaml } = prepareCloudRunWorker(`${sample}\nBOOTSTRAP_PLATFORM_ADMIN_PASSWORD=do-not-export\nPORT=3000\nHOST=0.0.0.0\nARBITRARY_SECRET=do-not-export\nGOOGLE_APPLICATION_CREDENTIALS=do-not-export\nIFOOD_WEBHOOK_SECRET=do-not-export`);
    expect(yaml).not.toContain('do-not-export');
    expect(yaml).not.toMatch(/name: (HOST|PORT|BOOTSTRAP_)/);
  });

  it('quotes dollar signs, hashes, quotes, multiline content and YAML line separators', () => {
    const { yaml } = prepareCloudRunWorker(`${sample}\nSMTP_PASSWORD='a#b:"c"$ENV\nnext\u0085\u2028\u2029end'`);
    expect(yaml).toContain('value: "a#b:\\"c\\"$ENV\\nnext\\u0085\\u2028\\u2029end"');
  });

  it('validates each input independently without reusing the runtime cache', () => {
    prepareCloudRunWorker(sample);
    expect(() => prepareCloudRunWorker('')).toThrow();
    expect(() => prepareCloudRunWorker(`${sample}\nNODE_ENV=production`)).toThrow();
  });

  it('never copies the API-only master entry secret into worker configuration', () => {
    const { yaml } = prepareCloudRunWorker(`${sample}\nMASTER_ACCESS_TOKEN=master-entry-test-secret-do-not-export`);
    expect(yaml).not.toContain('MASTER_ACCESS_TOKEN');
    expect(yaml).not.toContain('master-entry-test-secret-do-not-export');
  });
});
