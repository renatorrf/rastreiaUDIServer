# Rastreia backend

API da fundação do RastreiaAPP.

## Requisitos

- Node.js 22 ou superior.
- PostgreSQL com as extensões `citext` e `pgcrypto`. PostgreSQL 16+ com PostGIS é recomendado para produção.
- Redis é opcional em desenvolvimento e recomendado/obrigatório para múltiplas réplicas em produção.

## Execução local

```powershell
Copy-Item .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev
# em outro terminal
npm run dev:worker
```

Troque todas as credenciais e segredos do `.env`. O seed é idempotente pelo slug do tenant e cria somente o primeiro gestor local.

## Worker no Cloud Run

A API e o worker são processos separados. Para corrigir o aviso “Worker: Ainda não executado” no ambiente hospedado, siga [o guia de implantação do Worker Pool](docs/cloud-run-worker.md), com [modelo YAML](deploy/cloud-run/worker-pool.example.yaml). A configuração inicial é pausada; a ativação é explícita e pode consumir filas reais. O guia não altera a URL da API nem o webhook.

## Scripts

- `npm run build`: compila TypeScript estrito.
- `npm run lint`: valida o código.
- `npm test`: executa testes unitários.
- `npm run db:migrate`: aplica migrations pendentes em ordem.
- `npm run db:inspect`: mostra versão, extensões necessárias e presença do schema, sem exibir credenciais.
- `npm run db:seed`: cria tenant e gestor de bootstrap.
- `npm run smoke:phase1`: valida no banco configurado o fluxo completo da Unidade 1 e remove os dados temporários ao final.
- `npm run smoke:phase2`: acrescenta emissão, reemissão, expiração, revogação e privacidade do acompanhamento público à validação integrada.
- `npm run smoke:phase3`: acrescenta ingestão de GPS, filtro de qualidade, idempotência por evento, credencial nativa restrita, escopo operacional/público e Socket.IO à validação integrada.
- `npm run smoke:phase4`: acrescenta comprovante, payload criptografado, worker de mensagens e callback idempotente à validação integrada.
- `npm run smoke:phase5-scale`: valida migration, DLQ, lease e RLS; com `REDIS_URL`, valida também ping e exclusão mútua do lease.
- `npm run smoke:phase6-horizontal`: valida duas réplicas, broadcast Redis, workers concorrentes, DLQ e replay no Compose de homologação.
- `npm run dev:worker`: executa o consumidor do outbox de Web Push, WhatsApp e SMS.
- `npm run push:generate-keys`: gera o par VAPID que deve ser copiado com segurança para o ambiente.

## Endpoints da fundação

- `GET /health/live`, `GET /health/ready` e `GET /health/version`
- `GET /internal/metrics` com bearer operacional exclusivo
- `POST /auth/login`, `/auth/refresh`, `/auth/logout`
- `GET|PATCH /tenants/current`
- `GET|POST /stores`
- `GET|POST /users`
- `GET|POST /couriers`
- `GET /maps/config` e `GET /public/maps/config`
- `GET /geo/autocomplete?q=...`
- `GET|POST /deliveries` e `GET /deliveries/:id`
- `POST /deliveries/:id/assign|collect|start|complete|fail|cancel`
- `POST /deliveries/:id/tracking-link` e `POST /deliveries/:id/tracking-link/revoke`
- `GET /public/tracking/:token`
- `POST /courier/location` e `POST /courier/location/batch`
- `POST /courier/background-tracking-sessions`, `DELETE /courier/background-tracking-sessions/:id` e `POST /mobile/location`
- `GET /locations/active`
- `GET /operations/queue-health`, `GET /operations/dead-letters` e `POST /operations/dead-letters/:id/replay`
- `GET /push/status` e `PUT|DELETE /push/subscriptions`
- `POST /deliveries/:id/tracking-message` e `GET /deliveries/:id/messages`
- `POST|GET /deliveries/:id/proofs` e `GET /public/tracking/:token/proof`
- `GET|POST /webhooks/whatsapp`
- Socket.IO `/operations` autenticado por access token e `/tracking` autenticado pelo token público no handshake.

O login recebe `tenantSlug`, `email` e `password`. O access token é devolvido no corpo; o refresh token rotativo fica em cookie HttpOnly. Toda consulta operacional abre uma transação e configura o contexto RLS do tenant e do usuário.

Mesmo quando `DATABASE_URL` pertence ao dono do schema ou a um superusuário, as transações da API assumem o papel sem login `rastreia_runtime`, criado pela migration `0005`. Isso impede que a aplicação contorne as políticas `FORCE ROW LEVEL SECURITY`.

Todas as mutações de entrega exigem `Idempotency-Key`. Repetir a mesma requisição com a mesma chave devolve o resultado persistido sem duplicar estado, histórico, auditoria ou evento outbox.

Configure `PUBLIC_TRACKING_BASE_URL`, um `TRACKING_TOKEN_PEPPER` secreto com pelo menos 32 caracteres, `TRACKING_TOKEN_TTL_SECONDS` e `TRACKING_COMPLETED_GRACE_SECONDS`. O link público é devolvido somente no momento da emissão; apenas seu HMAC-SHA-256 é persistido. Por esse motivo, a emissão do link não usa a tabela de respostas idempotentes, que armazenaria o token em texto puro.

Os pontos de localização aceitos têm precisão de até 100 metros, timestamp recente, ordem crescente e deslocamento fisicamente plausível. A última posição é atualizada a cada ponto válido; o histórico é amostrado a cada 30 segundos ou 100 metros. O cliente PWA mantém no máximo 100 pontos offline e tenta reenviá-los em lote ao recuperar conectividade.

Com `REDIS_URL`, a última posição e a presença ganham cache com TTL e os broadcasts do Socket.IO atravessam réplicas. O PostgreSQL mantém a projeção unitária de contingência e o histórico auditável amostrado. O outbox usa lease, backoff exponencial, DLQ e replay auditado; consulte `../docs/operacao-redis-e-filas.md` para configuração e homologação.

Cada resposta inclui `X-Request-Id`; logs e traces compartilham correlação sem anexar corpos, tokens ou coordenadas. Configure `METRICS_BEARER_TOKEN` para Prometheus e `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` para enviar traces amostrados a um OpenTelemetry Collector. Em produção, a validação de ambiente exige HTTPS, Redis TLS, storage S3, cookies seguros, segredos distintos e retenção explicitamente aprovada.

A migration `0022` prepara retenção diária em lotes. Ela permanece inativa até `RETENTION_ENABLED=true`. Política, backup/restore, rotação e incidentes estão em `../docs/runbook-producao.md`.

A topologia descartável com duas APIs e dois workers está em `../compose.homologation.yaml`; falhas de Redis/PostgreSQL e restore isolado são orquestrados conforme `../docs/homologacao-horizontal.md`.

O serviço nativo cria uma sessão limitada a uma entrega e configurável por `BACKGROUND_TRACKING_SESSION_TTL_SECONDS` (12 horas por padrão). O token é devolvido uma única vez, somente seu HMAC é persistido, e `/mobile/location` volta a validar perfil, tenant, vínculo e estado da entrega a cada ponto. O identificador determinístico compartilhado com a fila JavaScript evita duplicação entre o POST nativo e o reenvio de contingência.

## Comunicação e comprovantes

Configure um `MESSAGE_PAYLOAD_SECRET` exclusivo. O link destinado ao WhatsApp/SMS é cifrado com AES-256-GCM antes de entrar no outbox; o evento contém apenas IDs. O worker usa template utilitário do WhatsApp e pode alternar para o webhook SMS após falha. Em produção, configure também `WHATSAPP_APP_SECRET` para validar `X-Hub-Signature-256` nos callbacks.

O storage `local` atende desenvolvimento. Para produção, use `OBJECT_STORAGE_PROVIDER=s3` e configure bucket, região e credenciais; endpoints compatíveis como MinIO e R2 podem usar `S3_ENDPOINT` e `S3_FORCE_PATH_STYLE`. O banco armazena apenas URL de objeto, chave, checksum e metadados.
