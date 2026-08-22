import { buildApp } from './app.js';
import { getEnv } from './config/env.js';
import { loadLocalEnv } from './config/load-env.js';

loadLocalEnv();
const env = getEnv();
const app = await buildApp({ env });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Encerrando servidor');
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.fatal(error);
  process.exit(1);
}
