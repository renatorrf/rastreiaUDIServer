import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { prepareProductionSecrets } from '../security/production-secrets.js';

try {
  // Refuse to write credentials into a tracked/nonignored file.
  if (execFileSync('git', ['ls-files', '--', '.env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) {
    throw new Error('Tracked environment');
  }
  execFileSync('git', ['check-ignore', '-q', '.env'], { stdio: 'ignore' });
  const original = await readFile('.env', 'utf8');
  const prepared = prepareProductionSecrets(original);
  if (prepared.changed.length) {
    // Do not overwrite intervening changes made by another process.
    if (await readFile('.env', 'utf8') !== original) throw new Error('Environment changed');
    await writeFile('.env', prepared.contents, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(JSON.stringify({ updatedVariables: prepared.changed, credentialsDisplayed: false,
    externalServicesChanged: false }) + '\n');
} catch {
  // Exception details may contain filesystem or credential material; never echo them.
  process.stderr.write('Preparação interrompida. Revise duplicidades, chaves protegidas, rotação anterior e proteção Git do .env. Nenhuma credencial exibida.\n');
  process.exitCode = 1;
}
