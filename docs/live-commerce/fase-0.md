# Vendas por live no RastreiaAPP

## Escopo e situação da implantação

Levantamento de 21/10/2026 para executar `ESCOPO_COMPLETO_VENDAS_POR_LIVE_CODEX.md` em etapas, conforme sua seção 27. Esta entrega registra a descoberta técnica, decisões, menus, contratos e plano de migrações. Não ativa vendas, transmissão, cobrança nem menus incompletos em produção.

A migração anterior `0052_customer_authenticated_tracking.sql` foi aplicada separadamente ao banco configurado no ambiente. A Fase 0 de live commerce ainda depende da prova real com Amazon IVS; a conta AWS será criada pelo responsável pelo projeto.

Definições comerciais confirmadas nesta conversa:

- Lives serão um adicional contratado por **unidade**, independente da assinatura básica de entregas.
- Referência inicial: **4 lives por mês**, **2 horas por live**, **200 espectadores simultâneos por live**.
- Preço, quantidade e limites serão parametrizáveis pelo master, com histórico da contratação.
- Não habilitar automaticamente o adicional nas unidades existentes.

Detalhamento: [decisões de arquitetura](adrs.md) e [contratos de API e eventos](contratos.md).

## Inventário técnico confirmado

| Camada | Base existente | Integração prevista |
| --- | --- | --- |
| Frontend | `rastreia-front/rastreiaApp`, Angular 20.3.28 standalone, Ionic 8, RxJS, signals | Novas páginas lazy-loaded, sem outro bootstrap |
| Bootstrap | `src/main.ts`: Ionic modo iOS, interceptadores HTTP, Angular Service Worker somente web | Reutilizar providers; SDK de vídeo carregado apenas no estúdio/player |
| Navegação | `app.routes.ts`, `shell/app-shell.page.*`, split pane e navegação móvel por perfil | Grupo Vendas e acesso aos planos; manter navegação do entregador |
| Visual | Tema escuro e verde; `global.scss` agrega `theme/_design-system.scss` | Tokens e componentes existentes; não criar tema concorrente |
| Formulários | `ResponsiveEditorComponent`, estados de rede e timeout central | Modal móvel, painel desktop; prevenção de envio duplicado |
| Backend | Node 22+, TypeScript, Fastify 5, Zod; bootstrap `src/server.ts` e `src/app.ts` | Módulos comerciais no mesmo serviço |
| Autorização | `auth.guard.ts`, `AuthContext`, identidade de cliente separada | Tenant derivado da sessão; loja validada no servidor |
| Organização | `tenants`, `companies`, `stores`, `user_access_scopes` | Reaproveitar hierarquia e vínculos, sem recadastrar empresas |
| Banco em uso | PostgreSQL **9.6.24**, schema `rastreia`, papel `rastreia_runtime`, RLS | SQL compatível com 9.6 e isolamento por loja; não alterar SSL nesta tarefa |
| Migrações | SQL numerado, controle em `schema_migrations`, transação por arquivo | Incrementais e sem apagar dados; número atribuído ao implementar |
| Clientes | `modules/customers`, WhatsApp normalizado, identidade, perfis, rastreio autenticado | Cadastro/login só no checkout; não vincular conta apenas por telefone digitado |
| Logística | `modules/deliveries`, `modules/routes`, estados, auditoria e idempotência | Pedido comercial distinto de entrega; despacho idempotente |
| iFood | `external_orders`, eventos e comandos próprios do conector | Não reutilizar a tabela do iFood como tabela de vendas próprias |
| Tempo real | Socket.IO com Redis adapter; namespaces operations, tracking e consolidated-operations | Namespaces comerciais e eventos pequenos; vídeo direto pelo provedor |
| Assíncrono | `outbox_events`, leases, retry com backoff, dead letters, worker | Evoluir roteamento e consumidores antes de publicar eventos comerciais |
| Push | Web Push/VAPID global; dispositivos e notificações de clientes existentes | Reaproveitar chaves; destinatários resolvidos pelo backend |
| Arquivos | Abstração `ObjectStorage`, local ou S3; objetos privados | Pipeline próprio de imagens de catálogo, sem tornar documentos pessoais públicos |
| Cobrança | `billing_profiles`, `invoices`, itens, pagamentos manuais e bloqueios | Adicional de lives e consumo por unidade; não confundir com DRE da loja |
| Erros e operação | `AppError`, `correlation_id`, logs com redação, OpenTelemetry, health checks | Expandir redação para credenciais de transmissão e tokens de visitantes |
| Deploy | Front Firebase Hosting; API/worker Cloud Run, Dockerfile Node 22 | Publicação em fases, feature flags e migração anterior à versão dependente |
| Testes | Vitest/PGlite no backend; Karma/ChromeHeadless no frontend | Acrescentar concorrência em PostgreSQL real isolado e E2E móvel |

Não há dependências IVS nos manifests inspecionados. As variáveis `STREAM_PROVIDER`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` e `IVS_CHANNEL_TYPE` não estão definidas no ambiente local consultado. Isso não verifica permissões de uma futura identidade AWS.

## Menus e rotas planejados

Atualização de 21/10/2026: o subconjunto administrativo de catálogo e pacotes foi implementado localmente na [Fase 1A](fase-1a.md). Consulte esse registro para distinguir as rotas entregues das propostas abaixo. A migração 0053 foi aplicada ao banco configurado, mediante autorização; o deploy continua pendente.

Os caminhos abaixo são propostas, ainda não registrados no router. Mostrar cada entrada somente quando seu fluxo estiver implementado e autorizado; não preencher o menu com páginas vazias.

| Perfil e menu | Caminho proposto | Disponibilidade |
| --- | --- | --- |
| Loja → Vendas → Catálogo | `/app/vendas/catalogo` | Produtos, categorias, variantes e publicação; Fase 1 |
| Loja → Vendas → Estoque | `/app/vendas/estoque` | Saldos e movimentos; Fase 1 |
| Loja → Vendas → Importações | `/app/vendas/importacoes` | Upload, mapeamento, validação e confirmação; Fase 1 |
| Loja → Vendas → Pedidos | `/app/vendas/pedidos` | Pendentes como visão inicial, histórico por filtro; Fase 2 |
| Loja → Vendas → Lives | `/app/vendas/lives` | Lista, agenda, pacote e consumo; estúdio em `/:id/estudio`; Fase 3 |
| Gestor → Meu pacote de lives | `/app/vendas/plano` | Consulta de limites, preço e solicitação de contratação; Fase 1 |
| Gestor → Financeiro de vendas | `/app/vendas/financeiro` | Despesas, DRE gerencial e relatórios; Fase 5 |
| Master → Pacotes de lives | `/platform/pacotes-lives` | Versões de pacotes, preço, limites; Fase 1 |
| Master → Unidade → Adicionais | `/platform/unidades/:id/adicionais` | Ativação contratual, vigência e auditoria; Fase 1 |
| Público → Loja | `/loja/:storeSlug` | Catálogo sem login; Fase 1 |
| Público → Live | `/loja/:storeSlug/live/:publicToken` | Player e produto atual; Fase 3 |
| Público → Carrinho | `/loja/:storeSlug/carrinho` | Persistência por loja, sem login; Fase 1 |
| Público → Checkout | `/loja/:storeSlug/checkout` | Identificação e endereço conforme modalidade; Fase 2 |
| Cliente → Meus pedidos | `/cliente` | Integrar pedidos comerciais ao portal existente, sem segunda conta |

Operadores podem atender pedidos e operar lives somente nas unidades autorizadas; preços de pacote, contratação, despesas e credenciais não ficam sob sua administração. Gestor não pode aumentar a própria cota. Entregador continua vendo apenas logística, sem acesso ao catálogo administrativo, custos ou estúdio.

No celular, usar o menu “Mais” para novas áreas; não adicionar muitas abas à barra inferior. Formulários em modal, ações com loading, erro recuperável, foco e proteção de edição. Manter safe areas e testar 320, 375, 390, 430, 768, 1024 e 1200+ px.

## Plano incremental de migrações

Identificadores LC abaixo são nomes de planejamento, não arquivos executáveis nem números reservados. Todas as novas tabelas comerciais terão tenant/loja, FKs compostas coerentes, RLS, índices de consulta e auditoria. O master usa seu contexto próprio; o público recebe projeções mínimas, nunca acesso irrestrito às tabelas.

| Unidade de execução | Estruturas previstas | Verificação antes de habilitar |
| --- | --- | --- |
| LC01 Catálogo e adicional | `commerce_storefronts`, categorias, produtos, variantes, imagens; `live_plan_versions`, `store_live_subscriptions` | Slug único, SKU por loja, autorização, pacote inativo por padrão |
| LC02 Estoque e importação | `commerce_inventory_balances`, movimentos imutáveis, jobs e linhas de importação | Ajuste com motivo; concorrência; arquivo/linha idempotentes |
| LC03 Carrinho | Visitantes com token hash, carrinhos, itens, versões e chaves idempotentes próprias | Restauração e merge sem duplicar; separação entre lojas |
| LC04 Checkout | Reservas, pedidos, itens com snapshots, histórico, tentativas de pagamento, endereços congelados | Checkout concorrente, não vender acima do disponível, retry idempotente |
| LC05 Notificações | Caixa interna e entregas por destinatário; roteamento explícito de outbox | Worker antigo retirado antes dos primeiros eventos novos; deduplicação |
| LC06 Lives | Canais, sessões, playlist, eventos sequenciados; períodos de consumo, reservas de cota e sessões de audiência | 5ª live negada no pacote de 4; limite de 120 minutos e disputa de cota |
| LC07 Despacho | Relação pedido/entrega, solicitações versionadas e processamento idempotente | Sem dupla entrega após falha ou repetição de evento |
| LC08 Financeiro | Despesas, categorias, rateios e lançamentos gerenciais | DRE reproduzível com snapshots e permissões de custo |

Reversão operacional: desabilitar a feature e voltar a aplicação compatível, mantendo tabelas e registros. O runner atual só executa migrações para frente; não prometer rollback automático. Qualquer script de reversão estrutural ficará fora de `migrations/`, exigirá avaliação de dados e autorização. Não usar `DROP`, `TRUNCATE`, reseed ou índices concorrentes dentro da transação do runner. Triggers devem usar `EXECUTE PROCEDURE` para compatibilidade com 9.6.

## Riscos e decisões necessárias

1. **Vídeo ainda sem prova real:** conta AWS pendente. Não vender a capacidade de 200 como já homologada; medir estúdio, player e aplicação com carga antes da oferta comercial.
2. **Custo por audiência:** limitar só o número de lives não limita gastos. O pacote inclui duração, audiência, qualidade e franquia de consumo; ver ADR 4.
3. **Fila atual:** `processNotificationBatch` retira qualquer evento pendente e `processEvent` ignora tipos desconhecidos, mas o evento acaba marcado como processado. Publicar eventos comerciais só após evolução e substituição completa dos workers antigos.
4. **Idempotência de visitantes:** `withIdempotency` exige usuário autenticado. O carrinho anônimo precisa de identidade opaca própria; não inventar um usuário compartilhado.
5. **Banco 9.6:** validar migrations e concorrência nessa versão, além dos testes PGlite. Atualização de versão e plano de backup/restauração são uma frente separada com o provedor.
6. **Cobrança existente:** bloqueios financeiros atuais podem afetar a unidade inteira. Inadimplência exclusiva do adicional deverá bloquear novas lives, não pedidos/logística; não reutilizar esse bloqueio sem distinguir o tipo da cobrança.
7. **Cliente e pagamento:** manter login WhatsApp + senha; provedor de pagamento online ainda não escolhido. Pagamento manual deve ser explícito e auditado, nunca simular pagamento aprovado.
8. **Publicação:** assets worker/WASM do player precisam MIME correto; fallback SPA não pode retornar HTML no lugar deles. Revisar Firebase, CSP, CORS, cache e Service Worker.
9. **Imagens/importação:** limite atual de multipart é voltado a comprovantes; o storage local só aceita extensões de documentos/imagens. CSV/XLSX terão limites, validação e armazenamento próprios, sem ampliar indiscriminadamente o acesso atual.
10. **Segurança:** preços, tenant, custo e desconto vêm do servidor. Sessão de transmissão não pode vazar ao público; logs e observabilidade devem ocultar tokens, stream keys, endereços e dados de pagamento.

## Sequência de implementação e aceite

1. **Fechar Fase 0:** arquitetura abaixo registrada; criar conta AWS, escolher região/tipo de canal, validar custos e executar POC autorizada. Catálogo pode ser desenvolvido sem provisionar vídeo.
2. **Fase 1A:** adicional por unidade, versões de pacote e consulta de consumo; catálogo com CRUD e menus funcionais. Sem ativação/cobrança automática em unidades existentes.
3. **Fase 1B:** imagens, estoque, importação em prévia/confirmar; catálogo público e carrinho anônimo persistente.
4. **Fase 2:** identificação no checkout, reservas, pedidos e notificações internas. Aprovar teste de concorrência e isolamento entre lojas antes de pedidos reais.
5. **Fase 3:** IVS, estúdio/OBS, playlist, player, audiência e quotas. Encerrar live sem mutação de carrinhos, pedidos ou snapshots.
6. **Fase 4:** criação de entrega pelo serviço de domínio existente e rastreamento no portal, com retry idempotente e callbacks internos.
7. **Fase 5:** despesas, rateios, relatórios e DRE gerencial; sem alterar o faturamento da plataforma.
8. **Fase 6:** carga, segurança, acessibilidade, operação e homologação em dispositivos reais, com plano de contingência.

Cada unidade deve entregar migrations, API validada, UI completa, testes unitários/integrados, lint e build. Fluxos públicos exigem também E2E, teste de reconexão e inspeção móvel; sucesso local não equivale a publicação.

## Migração anterior aplicada e validação desta entrega

- Antes: 51 migrações; única pendência `0052_customer_authenticated_tracking.sql`.
- Execução: `npm run db:migrate`, concluída com sucesso.
- Depois: **52 aplicadas, nenhuma pendente** no banco configurado.
- Confirmadas as duas funções, `SECURITY DEFINER` e permissão de execução para `rastreia_runtime`.
- Transação somente leitura, sem sessão de cliente: snapshot retornou `NULL`; reivindicação de endpoint negada com código `42501`.
- Backend: `npm run build`, `npm run lint` e `npm test -- --maxWorkers=2` aprovados; **219 testes em 47 arquivos**.
- Testes focados de rastreio e VAPID global: 9 aprovados, incluídos no total acima.
- Sem novos componentes, tokens ou alterações de CSS nesta etapa; o frontend não foi alterado nem publicado.
- Não houve exclusão de registros, alteração de credenciais, criação de recurso AWS ou cobrança. A aplicação da migração não publica backend/worker nem comprova entrega de push em celular real.
