# Worker contínuo no Google Cloud Run

Configuração preparada em 02/09/2026. Nenhum recurso foi criado, worker iniciado ou segredo alterado durante a preparação. O modelo é para criar um **Worker Pool separado**, reutilizando a imagem do backend. Não é uma homologação da integração iFood real.

## O que muda

| Componente | Execução | Acesso |
| --- | --- | --- |
| API existente `rastreiaudiserver` | `node dist/server.js` | HTTP, Socket.IO e webhook |
| Novo pool `rastreiaudiworker` | `node dist/workers/notification-worker.js` | Consome filas no mesmo PostgreSQL; não recebe acesso do frontend |

O worker tem um loop contínuo, não um servidor HTTP nem uma tarefa que termina sozinha. Worker Pools atendem esse modelo e não fornecem URL pública. Não substitua o comando do serviço da API pelo comando do worker. [Modelo de execução e implantação](https://docs.cloud.google.com/run/docs/deploy-worker-pools).

A API continua em [rastreiaudiserver](https://rastreiaudiserver-401137614457.southamerica-east1.run.app). O webhook continua sendo `POST https://rastreiaudiserver-401137614457.southamerica-east1.run.app/integrations/ifood/webhook`. Nenhuma alteração adicional no frontend ou no cadastro do webhook é necessária por causa deste pool.

**Atenção:** esse worker também processa e-mails, push/WhatsApp/SMS, turnos, ofertas e expiração de disponibilidade. Faturamento e retenção seguem suas flags. Ativá-lo pode consumir filas antigas e produzir efeitos reais, mesmo com `NODE_ENV=development` ou `IFOOD_MODE=sandbox`. Revise as filas e os provedores antes de ativar; não habilite mocks apenas para esconder falhas de configuração.

## 1. Separar os dados de implantação

- ID real do projeto Google Cloud: veja no seletor de projetos. `401137614457` é o número conhecido, não o ID textual.
- Região: `southamerica-east1`, a mesma da API; confirme disponibilidade e cota no seu projeto ao criar o pool.
- Imagem: no Cloud Run, abra a revisão que atende a API e copie sua referência de imagem **com digest `@sha256:...`**. Não é a URL `run.app`, nem a URL do Git. A imagem precisa conter `dist/workers/notification-worker.js`; o build atual do backend já o inclui.
- Conta de serviço: selecione/crie uma conta dedicada ao worker, com apenas as permissões necessárias. Não use Owner/Editor como atalho. O operador precisa poder implantar Cloud Run, ler a imagem e atuar como essa conta. [Identidade do worker](https://docs.cloud.google.com/run/docs/configuring/workerpools/service-identity).
- Acesso à rede: reproduza as configurações necessárias de VPC/saída/Cloud SQL da API se forem usadas. O YAML de exemplo não inventa redes, conectores nem instâncias SQL. O banco e o Redis precisam ser alcançáveis pelo novo pool.

Não faça outro build se a revisão da API já contém o worker atualizado. A imagem inclui ambos os pontos de entrada. O pool sobrescreve apenas comando e argumentos; mantenha o diretório de trabalho da imagem (`/app` no Dockerfile, normalmente `/workspace` com buildpacks). [Configuração do container](https://docs.cloud.google.com/run/docs/configuring/workerpools/containers).

## 2. Conferir variáveis e segredos

O `.env` local **não é enviado nem herdado automaticamente** pelo Cloud Run. A referência é a configuração efetiva da revisão da API. Compare-a antes de criar o pool. O backend informado está em desenvolvimento; não altere o ambiente para contornar validações.

| Configuração | Regra para o worker |
| --- | --- |
| `NODE_ENV`, `DEPLOYMENT_ENVIRONMENT` | Mesmos valores da API. Informe `NODE_ENV` explicitamente: o Dockerfile tem padrão `production`. |
| `DATABASE_URL` | Mesmo banco e credencial operacional da API. O código configura `search_path=rastreia,public`; não existe variável extra de schema. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `TRACKING_TOKEN_PEPPER` | Mesmos valores existentes; exigidos pela validação compartilhada, mesmo sem login HTTP no worker. |
| `MESSAGE_PAYLOAD_SECRET` | Mesma chave da API. Se está vazia em desenvolvimento, mantenha vazia/ausente para usar o mesmo `TRACKING_TOKEN_PEPPER`. Nunca gere outra chave. |
| `IFOOD_ENABLED` | `true` para processar iFood. A conexão da unidade também deve estar habilitada. |
| `IFOOD_MODE`, `IFOOD_EVENTS_MODE` | Iguais aos da API e da conexão. Na verificação local eram `sandbox` e `webhook`; confirme na revisão hospedada. |
| `IFOOD_CLIENT_ID`, `IFOOD_CLIENT_SECRET` | Mesmas credenciais do aplicativo cadastrado na API. |
| `IFOOD_BASE_URL` | `https://merchant-api.ifood.com.br`; não trocar por uma URL fictícia de sandbox. |
| `REDIS_URL`, `REDIS_REQUIRED`, `REDIS_KEY_PREFIX` e demais opções Redis | Mesma instância, namespace e requisitos da API. A URL contém credencial e deve ser um segredo. |
| `SMTP_*`, `EMAIL_ACTION_BASE_URL`, `PUSH_*`, `WHATSAPP_*`, `SMS_*`, `PUBLIC_TRACKING_BASE_URL` | Reproduza as opções dos canais habilitados. URLs de convite/acompanhamento apontam para o frontend, não para o worker. Segredos dos provedores ficam no Secret Manager. |
| `COMMUNICATIONS_MOCK`, `BILLING_ENABLED`, `RETENTION_*`, `OUTBOX_*` | Preserve os valores/regras da API. O worker não é exclusivo de iFood. |
| `OBJECT_STORAGE_PROVIDER`, `S3_*` | Mesmo storage compartilhado, quando configurado. O disco local de um container não é compartilhado com o outro. |

Use **Secret Manager → Referenciar segredo** para URLs com senha, chaves JWT/criptografia, iFood e demais credenciais. Reutilize nomes/versões já configurados na API. Se ainda não existem no Secret Manager, cadastre os valores atuais por um canal seguro, sem regenerá-los. Dê à conta do worker `roles/secretmanager.secretAccessor` apenas nesses segredos. Prefira versões numéricas fixas. [Segredos em Worker Pools](https://docs.cloud.google.com/run/docs/configuring/workerpools/secrets).

O modelo inclui apenas a base comum/iFood; acrescente as opções condicionais da tabela antes de ativar. Não é um espelho automático da API. `IFOOD_WEBHOOK_ENABLED` e `IFOOD_WEBHOOK_SECRET` precisam continuar configurados na **API**, que recebe o webhook; o worker não publica esse endpoint.

### Se a API já estiver em produção

Além da tabela, a validação em `src/config/env.ts` exige `RELEASE_VERSION` semântica, `RELEASE_COMMIT` hexadecimal, ambiente de implantação explícito, `COOKIE_SECURE=true`, `APP_ORIGINS` e `PUBLIC_TRACKING_BASE_URL` HTTPS, `REDIS_REQUIRED=true` com `REDIS_URL=rediss://...`, `METRICS_BEARER_TOKEN` adequado, storage S3 com credenciais, quatro segredos distintos (JWTs, pepper e payload), `COMMUNICATIONS_MOCK=false` e `RETENTION_ENABLED=true`. Configure também as URLs HTTPS de e-mail quando aplicável. Preserve as demais opções de produção da API; não mude para development para evitar um `ZodError`.

## 3. Criar pelo console (caminho mais simples)

1. Abra **Cloud Run → Worker pools → Implantar container** no projeto correto. Não escolha Serviços nem Jobs.
2. Use a imagem com digest da API e nome `rastreiaudiworker`, na região `southamerica-east1`.
3. Configure inicialmente **0 instâncias** para revisão. Após a conferência, use **1 instância** para processar continuamente.
4. Em Containers, use comando `node` e um argumento `dist/workers/notification-worker.js`. Recursos iniciais: 1 vCPU e 512 MiB; acompanhe consumo durante os testes.
5. Em Variáveis e segredos, configure os itens da seção 2. Em Segurança, selecione a conta de serviço; em Rede, reproduza o acesso necessário ao banco/Redis.
6. Não configure porta 3000/8080 nem copie a probe HTTP `/health/live` da API. Este processo não abre HTTP. Crie o pool pausado, confira a configuração e só então altere a escala para 1.

O número de instâncias é manual. **Uma instância ativa gera cobrança mesmo ociosa; zero desativa o pool.** Não dependa de requisições à API para mantê-lo funcionando. [Escala e cobrança](https://docs.cloud.google.com/run/docs/configuring/workerpools/manual-scaling).

## 4. Alternativa: arquivo YAML e PowerShell

Execute na pasta `rastreia-backend`, com Google Cloud CLI atualizado e autenticado no projeto correto. Os comandos abaixo são para você executar quando for implantar; não foram executados durante a preparação.

```powershell
$workerManifest = '.\deploy\cloud-run\worker-pool.local.yaml'
if (Test-Path -LiteralPath $workerManifest) { throw 'O arquivo local já existe; revise-o sem sobrescrever.' }
Copy-Item -LiteralPath '.\deploy\cloud-run\worker-pool.example.yaml' -Destination $workerManifest
```

Edite `worker-pool.local.yaml`. Substitua **todos** os marcadores `__...__`, inclusive versões dos segredos, e acrescente as configurações condicionais da seção 2. Mantenha `manualInstanceCount: '0'`. Não insira senhas em `value`: use `valueFrom.secretKeyRef`. A cópia local é ignorada por Git e Docker.

Depois de revisar, o comando seguinte **cria/substitui** o pool:

```powershell
$workerProjectId = 'PREENCHER_ID_REAL_DO_PROJETO'
$workerRegion = 'southamerica-east1'
$workerManifest = '.\deploy\cloud-run\worker-pool.local.yaml'
if ($workerProjectId -eq 'PREENCHER_ID_REAL_DO_PROJETO') { throw 'Preencha o ID real do projeto.' }
if ((Get-Content -LiteralPath $workerManifest -Raw) -match '__[A-Z0-9_]+__') { throw 'Ainda existem marcadores não preenchidos no YAML.' }
gcloud run worker-pools replace $workerManifest --project=$workerProjectId --region=$workerRegion
if ($LASTEXITCODE -ne 0) { throw 'Falha na implantação; confira o erro sem compartilhar segredos.' }
```

Não use esse exemplo incompleto para sobrescrever um pool já configurado: `replace` é declarativo e pode remover opções que não constam no arquivo. Para atualizações futuras, trabalhe com a configuração completa vigente, preservando rede, segredos e recursos. Atualizações da imagem da API não atualizam automaticamente a imagem do worker; coordene as duas revisões.

**Ativar, após conferir filas/configuração:**

```powershell
gcloud run worker-pools update rastreiaudiworker --project=$workerProjectId --region=$workerRegion --instances=1
```

**Pausar:**

```powershell
gcloud run worker-pools update rastreiaudiworker --project=$workerProjectId --region=$workerRegion --instances=0
```

Pausar não desfaz envios ou comandos já executados; um lote em andamento pode terminar antes de o processo encerrar. A API permanece disponível e pode continuar enfileirando eventos. Não apague pedidos, filas ou tokens como procedimento de pausa.

## 5. Confirmar que resolveu

1. Confira que a escala está em 1 e que o container não fica reiniciando. Abra a aba **Logs** do pool. Não considere apenas “implantação concluída” como prova de funcionamento.
2. No frontend, entre como gestor, escolha a unidade vinculada e abra **Configurações → Integrações**. Atualize a tela após alguns segundos. O campo **Worker** deve passar de “Ainda não executado” para uma data/hora recente.
3. A consulta autenticada `GET /integrations/ifood/health`, no contexto da unidade, deve retornar `worker_status: RUNNING`. Ela considera recente um heartbeat de menos de 90 segundos.
4. Confira também últimos erros e eventos pendentes. O heartbeat é gravado no começo do ciclo: prova que o worker acessou o banco, mas **não** prova sozinho que chamadas/autenticação/dispatch no iFood tiveram sucesso.
5. Só após essa validação faça um pedido de teste autorizado no ambiente iFood escolhido. Não altere `last_worker_at` manualmente para esconder o aviso.

O Cloud Run pode concluir o deploy sem validar a saúde do processo; este modelo usa logs e o heartbeat persistido para verificação, sem adicionar servidor HTTP. [Limitação da confirmação de deploy](https://docs.cloud.google.com/run/docs/deploy-worker-pools).

### Se continuar “Ainda não executado”

| Sintoma | Conferir |
| --- | --- |
| Nenhum container ativo | Escala maior que zero; permissões, imagem e estado da revisão. |
| `ZodError` ao iniciar | Variáveis faltando/incompatíveis com `NODE_ENV`; o pool não herda as variáveis da API. |
| `Cannot find module` | Imagem antiga/sem build do worker, argumento ou diretório de trabalho incorreto. |
| Erro de Secret Manager | Conta de serviço, nomes, versões e acesso a cada segredo. |
| Falha de banco/Redis | Mesmas conexões da API, TLS, rede e permissões; schema/migrations compatíveis com a imagem. Não rode seed para corrigir. |
| Processo ativo, sem heartbeat | `IFOOD_ENABLED=true`, conexão habilitada, mesmo `IFOOD_MODE` e mesmo banco; outro worker pode deter a trava. |
| Heartbeat atual, pedidos pendentes | Último erro da integração, credenciais, permissões/merchant, limites externos e chave de payload iguais aos da API. |
| Eventos chegam, mas nada é processado | Webhook fica na API, consumo fica no pool; confirme ambos. Em modo polling, confirme também `IFOOD_EVENTS_MODE` consistente. |

Não execute `npm run dev:worker` localmente com esse mesmo banco apenas para testar a implantação: ele passa a consumir a fila compartilhada. Build/testes unitários podem ser executados sem iniciar o consumidor real.
