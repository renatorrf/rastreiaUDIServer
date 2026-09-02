# Integração iFood e ajustes visuais — relatório de implementação

Data: 02/09/2026. Referência: documento “IMPLEMENTAÇÃO — INTEGRAÇÃO IFOOD + AJUSTES VISUAIS”, partes 1–46.

## Estado da entrega

O fluxo de pedidos próprios funciona em **mock**: receber, persistir, importar sem duplicar, confirmar, preparar, criar/liberar a entrega, atribuir entregador, coletar, iniciar rota, enviar dispatch e receber cancelamento. A implementação reutiliza entregas, lotes, permissões, eventos operacionais, notificações e sockets existentes.

**Não é uma integração homologada nem ativada em produção.** O provider HTTP está preparado, mas não houve chamadas reais ao iFood. Também não foi implementada a seleção automática completa unidade → vinculados → rede: falta definir o repasse e as regras de oferta. Não interpretar “liberar busca” como atribuição automática; significa colocar a entrega na fila `AWAITING_COURIER`. A gestão atribui um entregador ou usa o marketplace existente, informando os valores e condições da oferta.

O `.env` real não foi alterado. As migrations 0035, 0036 e 0037 foram aplicadas à base de desenvolvimento configurada, no schema `rastreia`. Nenhum usuário ou pedido real foi apagado/alterado nos testes. Usuários, unidades e pedidos sintéticos foram criados em transações revertidas. Não houve deploy, envio real de e-mail/push nem geração de APK.

## Como testar sem credenciais

No backend, mantenha as configurações existentes e acrescente/ajuste:

```dotenv
IFOOD_ENABLED=true
IFOOD_MODE=mock
IFOOD_EVENTS_MODE=polling
IFOOD_POLLING_INTERVAL_MS=30000
IFOOD_WEBHOOK_ENABLED=false
```

Use `NODE_ENV=development` para habilitar a simulação pela interface. Não coloque secrets no Angular. API e worker devem usar o mesmo banco, modo e segredo de criptografia já existente (`MESSAGE_PAYLOAD_SECRET`, com fallback de desenvolvimento para `TRACKING_TOKEN_PEPPER`). Trocar esse segredo sem migração torna os payloads antigos ilegíveis.

Em terminais separados no backend:

```powershell
npm run db:migrate
npm run dev
```

```powershell
npm run dev:worker
```

No frontend (`rastreia-front/rastreiaApp`):

```powershell
npm run start:local
```

Entre como gestor, escolha a unidade e abra **Configurações → Integrações** (também disponível no menu). Cadastre um UUID de merchant exclusivamente sintético em mock, habilite a conexão e teste. Use “Simular pedido iFood”. Aguarde o worker; confira o horário de sua última execução na tela. A API sozinha não processa a fila.

Confirme o pedido, aguarde o evento de confirmação e libere a entrega quando configurado como manual. Em Entregas, atribua um entregador vinculado. O entregador usa coleta/início/conclusão normais. **Aceite e coleta não enviam dispatch; somente a saída efetiva para entrega envia.** Rotas em lote seguem a mesma regra, uma vez por pedido.

Para testar sem deixar cadastros sintéticos permanentes: `npm run smoke:ifood`. A opção `-- --ui` sobe uma API temporária em 3000, mostra credenciais sintéticas no terminal e mantém uma transação aberta até Ctrl+C. Não execute migrations durante esse modo: a transação pode bloquear DDL. Esse modo é para validação local, não hospedagem.

## 1. Arquivos criados

Caminhos relativos ao backend:

- `src/integrations/external-orders/external-order-provider.ts`: contrato genérico, sem regras de entregadores.
- `src/integrations/ifood/ifood.client.ts`: autenticação/cache/HTTP/timeout/erros.
- `src/integrations/ifood/ifood.provider.ts`: adapter HTTP.
- `src/integrations/ifood/ifood.mock.ts`: provider sem chamadas externas.
- `src/integrations/ifood/ifood.module.ts`: seleção centralizada do provider.
- `src/integrations/ifood/ifood.normalizer.ts`: projeção e validação de destino.
- `src/integrations/ifood/ifood.status.ts`: estados externos e prevenção de regressões.
- `src/integrations/ifood/ifood.integration.ts`: ingestão, eventos, comandos, liberação e cancelamento.
- `src/integrations/ifood/ifood.worker.ts`: processamento com trava de sessão PostgreSQL.
- `src/integrations/ifood/ifood.routes.ts`: endpoints e webhook assinado.
- `src/integrations/ifood/ifood.test.ts` e `src/smoke/ifood.ts`.
- `src/integrations/ifood/fixtures/{order-own-delivery,order-ifood-delivery,order-cash,order-prepaid,order-cancelled,event-new-order,event-confirmed,event-cancelled}.json`.
- Migrations da seção 3 e este relatório.

Caminhos relativos ao frontend:

- `src/app/core/api/integrations-api.service.ts`.
- `src/app/core/ui/external-order-panel.component.ts` e `.spec.ts`.
- `src/app/core/ui/integration-labels.ts`.
- `src/app/core/ui/sidebar-preference.service.ts` e `.spec.ts`.
- `src/app/pages/integrations/integrations.page.{ts,html,scss}`.

## 2. Arquivos modificados

Backend: `.env.example`, `package.json`, `src/config/env.ts`, `src/app.ts`, `src/modules/deliveries/delivery.service.ts`, `delivery.types.ts`, `src/shared/audit.ts`, `src/realtime/location-realtime.ts`, `src/workers/notification-worker.ts` e `notification-worker.service.ts`.

Frontend: `src/global.scss`, `src/theme/variables.scss`, `src/app/app.routes.ts`, `src/app/core/api/api.models.ts`, `src/app/core/realtime/location-realtime.service.ts`, `src/app/shell/app-shell.page.{ts,html,scss}`, `master-shell.page.{ts,html,scss}`, `src/app/pages/settings/settings.page.{ts,html}`, `src/app/pages/deliveries/deliveries.page.{ts,html}`, `src/app/home/home.page.ts` e `src/app/pages/people/people.page.ts`.

Em Pessoas, a inspeção do alerta revelou um formulário com `ngSubmit` sem `FormsModule`: recarregava a página antes de abrir a confirmação. O import foi corrigido e o diálogo foi validado/cancelado com usuário sintético. Não houve bloqueio real de vínculo.

O workspace já continha mudanças anteriores, inclusive eventos operacionais do entregador e vários diretórios ainda não rastreados pelo Git. Foram preservadas; o `git diff` total não representa apenas esta implementação.

## 3. Migrations criadas

- `0035_external_orders.sql`: conexões, pedidos/eventos/comandos externos, vínculos com entregas, RLS, índices e trigger de dispatch.
- `0036_external_command_scope.sql`: qualificação explícita da coluna na política RLS dos comandos, corrigida após teste com papel runtime.
- `0037_integration_polling_schedule.sql`: agendamento global de polling, heartbeat do worker e preservação criptografada de detalhes inválidos.

As três foram aplicadas em desenvolvimento. A 0035 foi previamente ensaiada com rollback. Não editar migrations já aplicadas; futuras correções devem usar nova migration.

## 4. Tabelas e campos

| Estrutura | Finalidade |
| --- | --- |
| `integration_connections` | Tenant/empresa/unidade/merchant, modo, habilitação, importação/criação, liberação imediata/agendada/manual, última execução/erro/evento, próxima consulta |
| `integration_events` | ID externo, códigos, referência ao pedido/merchant, payload original criptografado, detalhes consultados criptografados, estado, tentativas e próximo retry |
| `external_orders` | Identidade externa única por conexão, estado externo separado, entrega interna opcional, logística própria, dados criptografados, previsão e liberação |
| `integration_commands` | Uma operação por pedido: confirmar/preparar/dispatch/cancelar, estado de envio, tentativas, timestamps e erro sanitizado |
| `deliveries.origin` | `MANUAL` por padrão; `IFOOD` nas importadas |
| `deliveries.external_order_id` | Vínculo exclusivo com o pedido externo, com consistência de tenant |

Deduplicação usa `(provider, external_event_id)` e `(integration_id, external_order_id)`, além do vínculo único entre pedido e entrega. RLS usa tenant, unidade e vínculos vigentes. Entregadores e tracking público não recebem payload comercial completo.

Payloads são armazenados com a criptografia existente, não JSON em claro. Isso preserva o original mesmo na base LATIN1 atual. Destinos que não podem ser normalizados não geram coordenadas/endereço inventados: entram em erro reprocessável. Caracteres não suportados pela base podem exigir tratamento/migração para UTF-8 antes da operação real.

## 5. Endpoints

Todos os endpoints de gestão exigem sessão da unidade e papel autorizado; não são endpoints de master nem de entregador.

| Método e caminho | Acesso/efeito |
| --- | --- |
| GET `/integrations/ifood` | Gestor/operador: configurações e contadores do escopo |
| GET `/integrations/ifood/health` | Gestor/operador: heartbeat, últimos erros/eventos e pendências |
| PUT `/integrations/ifood/connection` | Gestor: configurar sua unidade; não permite redirecionar merchant existente |
| POST `/integrations/ifood/:id/test` | Gestor: verificar merchant, ou confirmar simulação |
| GET `/integrations/ifood/:id/events` | Gestor/operador: últimos 100 eventos, sem payload bruto |
| POST `/integrations/ifood/events/:id/reprocess` | Gestor: reenfileirar evento com erro |
| POST `/integrations/ifood/:id/simulate` | Gestor, exclusivamente development + mock, limitado por taxa |
| GET `/external-orders` | Pedidos do modo/escopo, filtro opcional `storeId`, últimos 100 |
| GET `/external-orders/:id` | Detalhes normalizados, estados e histórico de integração |
| GET `/external-orders/:id/cancellation-reasons` | Razões consultadas no provider, sem catálogo real inventado |
| POST `/external-orders/:id/actions` | `CONFIRM`, `PREPARE`, `CANCEL`, `CREATE_DELIVERY`, `RELEASE_DELIVERY` |
| POST `/integrations/ifood/webhook` | Sem sessão; só habilitado explicitamente, assinatura HMAC obrigatória |

Não existe endpoint público para forçar dispatch. Ele é enfileirado pela transição real da entrega. Códigos de erro são sanitizados; secrets e respostas integrais do upstream não vão ao navegador/log de erro.

## 6. Eventos e tempo real

Reutilizados os namespaces Socket.io `/operations` e `/consolidated-operations` com `operation:changed {storeId}`. O worker publica uma invalidação via `pg_notify('rastreia_operation_changed', ...)` na mesma transação da alteração; cada réplica da API escuta e entrega apenas aos sockets locais autorizados, evitando duplicidade pelo adapter Redis. Não há nome, telefone, endereço, pagamento ou payload bruto no evento.

Operação atualiza a lista sem reconstruir o mapa. Entregas e Integrações recarregam as projeções autorizadas. As duas listas têm fallback periódico; o painel de detalhes consulta a cada 15 segundos e cancela o polling ao destruir/trocar o componente. GPS, tracking público e ocorrências do entregador continuam no mecanismo anterior.

Outbox reutilizada: `external-order.changed`, `delivery.created` ao liberar o rascunho e `delivery.cancel` no cancelamento confirmado. A notificação de cancelamento alcança o entregador atribuído e gestores/operadores autorizados, quando há assinaturas push ativas. Envio a um celular real ainda precisa ser validado.

## 7. Variáveis adicionadas

| Variável | Padrão/uso |
| --- | --- |
| `IFOOD_ENABLED` | `false` |
| `IFOOD_MODE` | `mock`; admite `sandbox` e `production` |
| `IFOOD_CLIENT_ID` / `IFOOD_CLIENT_SECRET` | Vazios; exclusivamente backend |
| `IFOOD_BASE_URL` | `https://merchant-api.ifood.com.br`; modo real restringe ao host oficial |
| `IFOOD_EVENTS_MODE` | `polling`; alternativa `webhook` |
| `IFOOD_POLLING_INTERVAL_MS` | `30000`, mínimo 30 segundos |
| `IFOOD_WEBHOOK_ENABLED` | `false` |
| `IFOOD_WEBHOOK_SECRET` | Sobrescrita apenas para mock; no real usa client secret |
| `IFOOD_REQUEST_TIMEOUT_MS` | `15000` |

Modo sandbox não representa um host alternativo inventado: usa credenciais e merchant de teste fornecidos pelo iFood. Não habilitar ambos os transportes simultaneamente. Mock habilitado é rejeitado com `NODE_ENV=production`.

## 8. Testes criados

- `ifood.test.ts`: normalização, campos ausentes, logística própria, troco, tokens/cache/expiração, 401 limitado, 403/404/429/500, falha de rede, Retry-After, contratos polling/ACK/dispatch/cancelamento, preservação de metadados, assinatura e recuperação do worker.
- `smoke:ifood`: 66 verificações HTTP/PostgreSQL/Socket.io, incluindo RLS, duplicatas, busca agendada/manual, criação manual idempotente, erro e reprocessamento limitado, comandos incertos, cancelamento recusado, assinatura real do webhook e saída em lote.
- `sidebar-preference.service.spec.ts`: preferência inicial/persistida, mudança de viewport e storage indisponível.
- `external-order-panel.component.spec.ts`: BRL/troco, totais ausentes, espera pelo evento, logística terceirizada, respostas atrasadas e cancelamento do timer.

## 9. Funcionalidades implementadas

- Adapter mock/HTTP centralizado, sem segunda plataforma de entregas.
- Configuração por unidade, habilitação, teste, eventos, contadores e health.
- Simulações: própria, logística iFood, dinheiro/troco, online, cancelada e duplicada.
- Persistência antes de ACK, inclusive duplicatas/eventos não utilizados; erro de persistência não retorna ACK.
- Consulta de detalhes e filtro estrito `orderType=DELIVERY` + `delivery.deliveredBy=MERCHANT`.
- Destino, observações, itens/adicionais, pagamento, troco, total, taxa, desconto e previsão.
- `DRAFT` até liberação; não envia notificações de nova entrega antes disso.
- Confirmação/preparo/cancelamento assíncronos, pendentes até evento autoritativo.
- Dispatch apenas após `IN_ROUTE`, inclusive lotes que avançam o primeiro destino para `NEXT_STOP`.
- Cancelamento confirmado encerra entrega aberta, cancela ofertas, preserva histórico e ajusta paradas do lote. Cancelamento recusado não encerra a entrega.
- Desativar novas importações não interrompe os eventos de pedidos já existentes; desativar a conexão impede novos comandos/automação.
- Estados externos não retrocedem com eventos atrasados; concluir internamente não falsifica a conclusão no iFood.
- Tema global de alertas iOS/MD, cabeçalhos Faturas/Confiança, menu lateral recolhível/persistente e drawer móvel com rótulos completos.
- Badges de origem iFood nas listas/painéis, sem redesenho completo.

## 10. Pendências de credenciais e homologação

Obter client ID/client secret centralizados, merchant de teste e permissões do aplicativo no Portal do Desenvolvedor. Configurar somente no servidor, selecionar sandbox e cadastrar a conexão do merchant real de teste (separada de mock). Validar os contratos com o aplicativo liberado, especialmente cancelamento, event codes, status de preparo e campos opcionais por categoria/versão.

Não se garante homologação apenas trocando as variáveis. Ainda precisam ser ensaiados pedidos reais de teste, token/escopos, redelivery/ACK, assinatura configurada no portal, payloads completos, pagamentos/descontos, tempos, rejeições, dispatch e cancelamento. A arquitetura não exige outro módulo de entregas para isso, mas diferenças no contrato poderão exigir ajustes no adapter.

Referências oficiais consultadas:

- [Autenticação centralizada](https://developer.ifood.com.br/pt-BR/docs/guides/modules/authentication/centralized): OAuth form com `grantType`, `clientId`, `clientSecret` e token com expiração.
- [Polling de eventos](https://developer.ifood.com.br/pt-BR/docs/guides/modules/events/polling-overview): `/events/v1.0/events:polling`, merchants em lotes de até 100, ACK com lista de IDs. Foi utilizado `excludeHeartbeat=true`.
- [Assinatura de webhook](https://developer.ifood.com.br/pt-BR/docs/guides/modules/events/webhook-signature): HMAC-SHA256 dos bytes originais usando client secret.
- [Endpoints de pedidos](https://developer.ifood.com.br/pt-BR/docs/guides/modules/order/endpoints): detalhes, confirmação, preparo e dispatch de entrega própria.
- [Cancelamento](https://developer.ifood.com.br/en-US/docs/food/guides/modules/order/cancellation): leitura de `reasons[{code,description}]`, envio `{reason:code}`, aguardar cancelamento confirmado ou recusado.
- [Homologação](https://developer.ifood.com.br/pt-BR/docs/guides/modules/order/homologation): processo oficial ainda não executado.

## 11. Decisões técnicas e limitações abertas

1. Reutilização: `createDeliveryInTransaction`, máquina de estados/histórico, `routes`, outbox, worker de notificações e sockets. Não houve mudança nas APIs de navegação Geoapify/Google Maps/Waze nem nova coleta de GPS.
2. `AWAITING_COURIER` equivale ao estado conceitual SEARCHING_DRIVER do documento. Não foi criado um enum duplicado.
3. Automatização financeira pendente: não tratar a taxa cobrada ao consumidor como pagamento do entregador. Falta definir valor/cálculo, raio/janelas de oferta e a política de escalonamento unidade → vinculados → rede. Não há toggles sem implementação. A operação manual existente permanece disponível.
4. `BEFORE_READY_TIME` usa a previsão de entrega informada pelo provider (`deliveryDateTime`/janela agendada); não inventa tempo de preparo. Sem previsão válida, exige liberação manual. `preparationStartDateTime` impede iniciar preparo antes do horário agendado.
5. Repetição segura: eventos têm backoff e máximo de cinco tentativas. Comandos recebem retry automático limitado em 429. Timeout/5xx ou queda depois da reserva do envio tornam o resultado `UNCERTAIN`: não reenviar às cegas. Conferir no iFood e reconciliar por evento; ainda não existe botão para forçar reenvio de comandos incertos/recusados.
6. Não se promete exactly-once na API remota. Há deduplicação local, trigger transacional e proteção contra reenvios automáticos ambíguos.
7. Auditoria de automações usa ator de sistema nulo; o vínculo de autorização configurado é revalidado para importar/liberar. Revogação exige gestor autorizado reconfigurar a integração.
8. Cancelamento depois da coleta preserva responsável e histórico e avisa sobre devolução. Multas, compensação financeira e conclusão física da devolução precisam de decisão operacional; não foram calculadas automaticamente.
9. Hospedagem: executar API e worker com configuração coerente. No Cloud Run, somente subir o servidor HTTP não mantém polling funcionando. Providenciar execução contínua/CPU e monitoramento do worker, avaliar limites/escala e conexões de banco antes de produção. Nenhum recurso de nuvem foi criado aqui.
10. Definir política de retenção/anonimização dos novos payloads criptografados antes de produção; o serviço de retenção anterior ainda não os remove. A chave deve ter backup/rotação planejada. Não remover IDs usados na deduplicação sem considerar reentrega tardia.
11. O listener PostgreSQL perde atualizações enquanto desconectado; as listas Entregas/Integrações têm consulta periódica de recuperação. Reconexão automática do listener e testes de falha prolongada/réplicas são endurecimento pendente para produção.
12. Listas limitadas aos últimos 100 registros; paginação/exportação e maior volume ficam para evolução. Campos comerciais opcionais específicos de categorias/homologação devem ser ampliados conforme payloads reais.

## 12. Build frontend

`npm run build` passou. `npm run lint` passou. Build Ionic/Angular gerado em `www`; não foi sincronizado com Android/iOS nem publicado. O skill frontend foi aplicado para manter composição, cores e componentes existentes, com alterações pontuais e acessíveis.

## 13. Build backend

`npm run build` passou (`tsc`). `npm run lint` passou. Nenhuma dependência nova foi necessária para iFood; foram reutilizados fetch, pg, Zod, Fastify e criptografia existentes.

## 14. Resultado dos testes

| Verificação | Resultado |
| --- | --- |
| Backend `npm test` | 87 testes, 24 arquivos, passaram |
| `npm run smoke:ifood` | 66 verificações passaram, com rollback |
| `npm run smoke:driver-events` | 45 verificações passaram, incluindo Socket.io e RLS, com rollback |
| `npm run smoke:spec-revision` | 86 verificações passaram, com rollback |
| Frontend ChromeHeadless | 44 testes passaram |
| Build/lint backend e frontend | Passaram |
| Navegador | Login sintético, importação duplicada única, confirmação assíncrona, preferência do menu após reload, menu de 80px em 1100px, drawer completo em 390px, cabeçalhos escuros e diálogo escuro com texto legível |

Os smokes usam savepoints serializados dentro de uma transação externa: validam idempotência/replay e isolamento por papel, mas não simulam corrida entre duas transações independentes. O teste de integração Socket.io usa notificação PostgreSQL real e confirma ausência de dados pessoais e de entrega para socket de unidade irmã. Não foram testados credenciais reais iFood, concorrência distribuída sob carga, push em celular físico nem homologação de APK.

Avisos observados sem falha de build: aviso Angular preexistente sobre `disabled` em reactive forms nos testes; aviso do cache de desenvolvimento Vite sobre worker MapLibre. O segundo não alterou o build final, mas merece verificação se aparecer ao iniciar o mapa no ambiente local.

As APIs/servidores temporários de teste foram encerrados; o servidor do usuário na porta 8100 foi preservado.
