import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { prepareCloudRunWorker } from '../deployment/cloud-run-worker.js';

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error('INVALID_ARGUMENTS');
  const contents = await readFile(resolve('.env'), 'utf8');
  const prepared = prepareCloudRunWorker(contents);
  const directory = resolve('deploy/cloud-run');
  await mkdir(directory, { recursive: true });
  // Exclusive create: never overwrite an edited manifest or follow a file symlink.
  await writeFile(resolve(directory, 'worker-pool.local.yaml'), prepared.yaml,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  process.stdout.write(`Gerado deploy/cloud-run/worker-pool.local.yaml com ${prepared.variableCount} variáveis, sem exibir valores.\n`);
  process.stdout.write('CONFIDENCIAL: contém credenciais em texto claro. Mantenha apenas localmente.\n');
  process.stdout.write('Pendentes: imagem, conta de serviço e ID do projeto no comando de implantação. Pool pausado; nenhum acesso a banco ou nuvem.\n');
}

try {
  await main();
} catch (error) {
  if (error instanceof ZodError) {
    const fields = [...new Set(error.issues.map((issue) => issue.path.join('.')))];
    process.stderr.write(`Configuração inválida; revise os campos: ${fields.join(', ')}. Nenhum valor foi exibido.\n`);
  } else {
    const code = (error as NodeJS.ErrnoException).code;
    const message = code === 'EEXIST'
      ? 'O manifesto local já existe. Preserve/revise essa cópia; o gerador não sobrescreve arquivos.'
      : code === 'ENOENT'
        ? 'Execute na pasta rastreia-backend com um .env existente.'
        : 'Não foi possível gerar o arquivo. Confira argumentos e permissões locais.';
    // Avoid logging a thrown error or its stack: provider secrets may be input.
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = 1;
}
