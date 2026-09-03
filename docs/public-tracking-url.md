# URL pública de rastreio

A página compartilhada com o cliente pertence ao frontend Firebase. A API e o Socket.IO continuam no Cloud Run.

```dotenv
PUBLIC_TRACKING_BASE_URL=https://rastreiaudi.web.app/rastrear
```

O backend acrescenta o token ao emitir o link, formando `https://rastreiaudi.web.app/rastrear/<token>`. Não inclua um token fixo na variável.

Atualize essa variável no serviço da API no Cloud Run e no worker que utilizar a configuração. Alterar o `.env` ou o manifesto local não atualiza automaticamente recursos já implantados. O manifesto `deploy/cloud-run/worker-pool.local.yaml` contém credenciais: não versionar nem compartilhar.

Os links já enviados e as mensagens já enfileiradas mantêm o endereço antigo. Para um token ainda válido, basta substituir a origem antiga pela origem do Firebase e preservar `/rastrear/<token>`. Emitir um novo link pela aplicação revoga o anterior; faça isso apenas quando quiser substituir o acesso anterior.

Verificação após implantação: obtenha um link pela aplicação e confirme que começa com `https://rastreiaudi.web.app/rastrear/`. Abra-o em janela anônima. A tela pública deve consultar a API do Cloud Run sem exigir login. Não publique o token em logs ou chamados.
