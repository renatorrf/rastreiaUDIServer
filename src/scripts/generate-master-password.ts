import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateMasterPassword, updateMasterPasswordEnv } from '../security/master-password.js';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--write-env')) {
  throw new Error('Uso: npm run security:generate-master-password [-- --write-env]');
}

if (args[0] === '--write-env') {
  const filename = resolve(process.cwd(), '.env');
  // Exige um .env existente e mantém todas as outras configurações intactas.
  const current = await readFile(filename, 'utf8');
  const updated = updateMasterPasswordEnv(current, generateMasterPassword());
  await writeFile(filename, updated, 'utf8');
  process.stdout.write('Nova senha segura salva em BOOTSTRAP_PLATFORM_ADMIN_PASSWORD no .env local.\n');
  process.stdout.write('Este comando não altera contas no banco nem variáveis do Cloud Run.\n');
  process.stdout.write('Para criar o primeiro Master, execute npm run db:seed. Se ele já existe, o seed não troca a senha.\n');
} else {
  process.stdout.write(`BOOTSTRAP_PLATFORM_ADMIN_PASSWORD=${generateMasterPassword()}\n`);
  process.stderr.write('Guarde em local seguro; não envie a senha ao Git, chats ou logs de deploy. Nenhuma configuração foi alterada.\n');
}
