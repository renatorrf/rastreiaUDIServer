import { parseEnv } from 'node:util';
import { parseAppEnv } from '../config/env.js';

// Neither these HTTP/bootstrap settings nor unrelated process.env credentials
// belong in the worker export. Keep the runtime's validated defaults explicit.
const excludedKeys = new Set([
  'PORT', 'HOST', 'GEOAPIFY_API_KEY', 'IFOOD_WEBHOOK_SECRET',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET',
  'MASTER_ACCESS_TOKEN',
]);

function yamlString(value: string): string {
  // JSON quoting is also YAML quoting, with these additional YAML line breaks.
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function prepareCloudRunWorker(contents: string): { yaml: string; variableCount: number } {
  const source = parseEnv(contents.replace(/^\uFEFF/, ''));
  for (const key of Object.keys(source)) {
    if (key.startsWith('BOOTSTRAP_') || excludedKeys.has(key)) delete source[key];
  }
  // Validate without getEnv's global cache, loading .env into process.env,
  // expanding shell expressions, contacting providers or opening a DB pool.
  const environment = Object.entries(parseAppEnv(source))
    .filter(([key, value]) => value !== undefined && !key.startsWith('BOOTSTRAP_') && !excludedKeys.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value: String(value) }));

  const lines = [
    '# CONFIDENCIAL: credenciais em texto claro, copiadas do .env local.',
    '# Nao enviar ao Git, chats, prints, Docker ou uploads de codigo-fonte.',
    '# Nenhum deploy realizado. Escala zero; revisar antes de ativar.',
    '# Use Secret Manager para producao. O .env original nao foi alterado.',
    'apiVersion: run.googleapis.com/v1',
    'kind: WorkerPool',
    'metadata:',
    '  name: rastreiaudiworker',
    '  annotations:',
    "    run.googleapis.com/manualInstanceCount: '0'",
    'spec:',
    '  template:',
    '    spec:',
    "      serviceAccountName: '__WORKER_SERVICE_ACCOUNT_EMAIL__'",
    '      containers:',
    '        - name: worker',
    "          image: '__BACKEND_IMAGE_WITH_SHA256_DIGEST__'",
    "          command: ['node']",
    "          args: ['dist/workers/notification-worker.js']",
    '          resources:',
    '            limits:',
    "              cpu: '1'",
    "              memory: '512Mi'",
    '          env:',
  ];
  for (const variable of environment) {
    lines.push(`            - name: ${variable.name}`, `              value: ${yamlString(variable.value)}`);
  }
  return { yaml: `${lines.join('\n')}\n`, variableCount: environment.length };
}
