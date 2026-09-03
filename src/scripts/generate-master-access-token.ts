import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

try {
  const contents = await readFile('.env', 'utf8');
  const matches = [...contents.matchAll(/^[\t ]*(?:export[\t ]+)?MASTER_ACCESS_TOKEN[\t ]*=/gm)];
  if (matches.length > 1) throw new Error('duplicate');
  const existing = parseEnv(contents).MASTER_ACCESS_TOKEN;
  if (existing?.trim()) {
    if (existing.trim().length < 32 || existing.trim().length > 256) throw new Error('invalid');
    process.stdout.write('MASTER_ACCESS_TOKEN já definido. Valor preservado e não exibido.\n');
  } else {
    // Refuse multiline/ambiguous assignments instead of damaging the rest of .env.
    if (matches.length && !/^[\t ]*(?:export[\t ]+)?MASTER_ACCESS_TOKEN[\t ]*=[\t ]*(?:""|'')?[\t ]*(?:#[^\r\n]*)?\r?$/m.test(contents)) {
      throw new Error('ambiguous');
    }
    const assignment = `MASTER_ACCESS_TOKEN=${randomBytes(32).toString('base64url')}`;
    const newline = contents.includes('\r\n') ? '\r\n' : '\n';
    const updated = matches.length
      ? contents.replace(/^[\t ]*(?:export[\t ]+)?MASTER_ACCESS_TOKEN[\t ]*=[^\r\n]*/m, assignment)
      : `${contents}${contents.endsWith('\n') ? '' : newline}${assignment}${newline}`;
    await writeFile('.env', updated, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write('MASTER_ACCESS_TOKEN gerado no .env local, sem exibir o valor. Copie-o com segurança para a API no Cloud Run.\n');
  }
} catch {
  process.stderr.write('Não foi possível preparar o token. Verifique .env, permissões, duplicidades e tamanho (32 a 256). Nenhum valor exibido.\n');
  process.exitCode = 1;
}
