import { loadEnvFile } from 'node:process';

export function loadLocalEnv(): void {
  if (process.env['NODE_ENV'] === 'test') return;

  try {
    loadEnvFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
}
