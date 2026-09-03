# Entrada protegida do Master

O link **Acesso master**, no rodapé do login da operação, abre a verificação do token. Depois de validá-lo, o administrador informa seu e-mail e senha habituais. Não houve alteração de usuários, senhas ou permissões no banco.

## Configuração

Na pasta do backend, execute:

```powershell
npm run security:generate-master-access-token
```

O script gera 32 bytes aleatórios (43 caracteres base64url) em **MASTER_ACCESS_TOKEN**, no `.env` local. Preserva um valor válido já existente, não exibe o segredo e recusa duplicidades ou atribuições ambíguas. O valor configurado deve ter de 32 a 256 caracteres; não reutilize senhas, chaves JWT ou credenciais de outros serviços.

Consulte o valor diretamente no arquivo local e guarde-o em um gerenciador de senhas. Nunca o coloque no frontend, em arquivos `environment*.ts`, links, prints, logs ou no repositório.

## Implantação no Cloud Run

1. Configure **MASTER_ACCESS_TOKEN** no serviço **da API** (`rastreiaudiserver`), preferencialmente como referência a um segredo no Secret Manager. Use o mesmo valor do ambiente que deseja acessar.
2. Implante o backend atualizado com essa configuração e atualize o frontend em sequência. A versão antiga do frontend não envia a nova autorização e não consegue iniciar novos logins Master no backend atualizado.
3. Para APK, recompile o frontend e sincronize os arquivos Android antes de gerar a nova versão.
4. Abra o login, clique em **Acesso master**, informe o token e, em seguida, seu e-mail e senha administrativos.

O arquivo `.env` não é enviado ao Cloud Run. Executar o gerador local não configura o serviço remoto. **Sem a variável, novos logins Master ficam bloqueados (503)**; isso não impede a inicialização da API ou do worker. Um valor não vazio fora dos limites é rejeitado pela validação de ambiente. O worker não precisa do token, e o exportador de configuração o exclui.

## Comportamento e limites

- `POST /platform/auth/access` recebe `{ "token": "..." }` e verifica o segredo no servidor, com comparação de digests em tempo constante.
- A resposta autoriza somente a tentativa de login por cinco minutos. Essa autorização não é uma sessão administrativa nem permite usar APIs Master.
- `POST /platform/auth/login` exige o cabeçalho `X-Master-Login-Grant`, além de e-mail e senha. Sem uma autorização válida, o serviço de autenticação nem é executado.
- O frontend mantém apenas a autorização temporária em memória. Recarregar a página perde essa autorização. O token digitado é limpo ao enviar o formulário; não é salvo pela aplicação.
- São permitidas até cinco tentativas por minuto, por IP e por rota, em cada instância. O limite atual é local à instância, não um bloqueio distribuído entre réplicas. A configuração de proxy precisa preservar o IP confiável do cliente.
- Respostas de verificação/login usam `Cache-Control: no-store`; token e autorização não devem ser registrados nos logs.
- Trocar o token no ambiente e reiniciar/reimplantar a API invalida as autorizações temporárias antigas. Não revoga sessões administrativas já autenticadas; a sessão e sua renovação mantêm as regras existentes.
- Para desativar **novos** logins Master, deixe a variável vazia e reimplante. Isso não é um mecanismo de revogação de sessões.

O token compartilhado é uma barreira adicional solicitada para a entrada, **não MFA**. Use HTTPS no ambiente hospedado e restrinja o compartilhamento do token. Em produção, considere proteção de borda/limites distribuídos e um segundo fator individual (por exemplo, passkey/TOTP). Referências: [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) e [OWASP MFA Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html).

## Verificações

```powershell
npm run build
npm run lint
npm test
```

Os testes de entrada Master usam credenciais sintéticas e serviços de autenticação simulados, sem acessar o banco ou enviar e-mails. Cobrem segredo ausente/incorreto, expiração, adulteração, rotação, separação de tokens, limitação de tentativas e login direto sem autorização.
