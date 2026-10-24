# Fase 1E — checkout e pedidos do catálogo

Implementação local em 24/10/2026. **Migração 0060 aplicada em 24/10/2026, após autorização, no banco configurado no ambiente. Sem deploy ou alteração de credenciais.**

## Fluxo aprovado

Cliente monta o carrinho em `/loja/:slug`, entra com WhatsApp e senha, confere o cadastro e escolhe entrega ou retirada. O endereço vem do perfil ativo vinculado à identidade autenticada (o mais recentemente atualizado). Nenhum endereço, preço, custo, cliente, tenant ou unidade informado livremente pelo navegador substitui os dados do servidor.

O pedido chega a **Vendas → Pedidos do catálogo**, em `/app/vendas/pedidos`, aguardando confirmação. O cliente consulta suas compras em `/cliente/pedidos-catalogo`, acessível também por Minha conta → Ver compras do catálogo. A consulta é independente do histórico logístico existente. O login iniciado no carrinho retorna apenas para uma rota local de catálogo validada, sem redirecionamento externo.

Frete, prazo e pagamento ficam a combinar com a loja. O valor mostrado é o subtotal dos produtos, não um total com frete calculado. Não existe cobrança online, pagamento presumido, criação automática de entrega ou rastreio nesta fase. O cadastro/ativação do cliente continua seguindo o fluxo existente.

## Regras e consistência

- Uma conversão por carrinho, protegida por bloqueio transacional, unicidade e hash do conteúdo. Reenvio idêntico retorna o mesmo pedido. O cabeçalho de idempotência é obrigatório; nas transições administrativas também é usado o registro existente de idempotência.
- Variantes, tamanho/cor, SKU, quantidade, preço e observação de preparo são copiados para itens imutáveis. Alterações posteriores do catálogo não reescrevem o pedido. Custos e coordenadas não são incluídos no DTO de consulta.
- O checkout verifica versão do carrinho e do cadastro, senha definitiva, catálogo público, disponibilidade, preço e regras de preparo. Preço alterado exige revisão, não é aceito silenciosamente.
- Produtos com estoque ficam reservados por **10 minutos**, enquanto aguardam a loja. Produtos sob encomenda não reservam nem baixam saldo físico.
- `RECEIVED → CONFIRMED`: baixa o saldo e libera a reserva, com movimento de estoque. `RECEIVED → CANCELLED/EXPIRED`: libera a reserva. `CONFIRMED → CANCELLED`: devolve os produtos ao saldo. Cancelamento exige motivo. `CONFIRMED → COMPLETED`: encerra o atendimento comercial sem outra baixa.
- A confirmação/cancelamento é feita dentro do painel/modal de detalhes, com explicação da consequência e confirmação explícita; não utiliza alert nativo.
- Worker atualizado libera reservas vencidas; checkout e transições da mesma loja também verificam vencimentos. O job é separado do outbox logístico. Se o worker estiver parado, a consulta pode manter o status recebido até a manutenção ou próxima operação; uma confirmação após o prazo não é aceita.
- RLS e funções autorizadas isolam cliente, tenant e loja. Gestor precisa ter acesso à unidade. Cliente não altera status. Não há DELETE/UPDATE direto das novas tabelas pelo runtime.
- Carrinho convertido fica bloqueado, inclusive para clientes antigos. Nova compra gera outra identidade de carrinho. A fila persistente conserva a mesma operação após timeout/5xx e não permite reenviar o checkout com outra conta. IndexedDB impede uma aba antiga de sobrescrever a nova compra.
- Listas atualizam a cada 15 segundos enquanto visíveis, com botão de atualização manual; detalhe do cliente também consulta o estado atual. A edição do gestor usa versão otimista. Não há push/WhatsApp automático para eventos comerciais nesta fase.

## Arquivos principais

### Criados

- `migrations/0060_commerce_checkout_orders.sql`: pedidos, itens, eventos, reserva/expiração, transições e proteção dos carrinhos convertidos.
- `src/modules/commerce/order.routes.ts`: checkout autenticado, cadastro para conferência, consultas e transições.
- `src/modules/commerce/order-maintenance.ts`: liberação periódica das reservas.
- `src/modules/commerce/order-security.test.ts`: limites HTTP, identidade, consentimento e validação de dados.
- Frontend `core/api/commerce-order.types.ts`, `pages/commerce/checkout.component.ts`, `pages/commerce/orders.page.ts/.html`, `pages/commerce/orders.spec.ts`: contratos, checkout compartilhado, consulta do cliente e fila do gestor.

### Alterados

- Backend `app.ts`, `notification-worker.ts`, `commerce.integration.test.ts`: registro, manutenção e testes SQL.
- Frontend carrinho/cache/contratos/testes: envio persistente, recuperação, bloqueio de carrinho convertido e nova compra.
- Frontend catálogo/carrinho/templates: conclusão, navegação fechando o modal e recibo após envio.
- Frontend login, rotas, shell e portal do cliente: retorno ao catálogo e acessos aos pedidos.
- `tools/commerce-preview/main.ts`: API e identidade fictícias isoladas para conferência visual; não importada pela aplicação real.

## Design System e UX

Skill frontend aplicada preservando tema escuro/verde e composição task-first. Reutilizados tokens, `app-content`, grids, feedback, skeletons, listas comerciais e `ResponsiveEditorComponent`: painel no desktop, modal no celular. Checkout é um componente compartilhado pelo carrinho nas duas apresentações. Sem novos tokens, CSS local, bibliotecas ou duplicação de estilos; não foi necessária remoção de CSS legado. Fila, carregamento, vazio, erro, consentimento e processamento têm estados explícitos. Ajustado o fechamento do modal ao navegar para login/histórico e a visibilidade do número/status no cabeçalho mobile.

## Validação local

- Backend: build e lint aprovados; **112 testes comerciais aprovados**, incluindo SQL PostgreSQL/PGlite e limites HTTP. Cobertura de reserva, disputa entre carrinhos, replay, dados imutáveis, variantes/preparo, estoque sob encomenda, cancelamento, conclusão, vencimento e isolamento.
- Frontend: build de produção/TypeScript/templates aprovados; lint direcionado aprovado (aviso de configuração ESLint legada); **62 testes selecionados aprovados**, incluindo carrinho, IndexedDB, pedidos e shell. O fixture isolado do shell emite aviso Ionic sobre `content` do menu; os testes passam.
- Suíte geral do backend: **330 aprovados e 5 falhas** em `workday.integration.test.ts`, fora deste módulo. O fixture usa horários 09h–23h e a execução ocorreu após 23h; testes de lembrete/check-in entram em estado de jornada encerrada. Nenhuma regra de jornada foi alterada nesta etapa.
- Navegador com dados fictícios: inclusão de variante, gravação de observação, conferência, envio, consulta do cliente e confirmação pela loja; console sem erros na prévia. Detalhes verificados em 320, 375, 390, 430, 768, 1024 e 1280 px sem overflow horizontal. Evidência no frontend `.data/checkout-pedido-loja.jpg`.
- Isso não comprova implantação, concorrência de múltiplas conexões no PostgreSQL 9.6 real, notificação push ou APK físico. A prévia usa API fictícia, sem banco real.

## Ativação pendente

1. **Concluído:** migração 0060 aplicada no PostgreSQL 9.6.24. Verificação posterior confirmou 60 migrações aplicadas, nenhuma pendente, RLS habilitada e forçada nas três novas tabelas, sem escrita direta pelo runtime. Funções internas de manutenção e implementações anteriores do carrinho permanecem sem permissão de execução pelo runtime.
2. Publicar backend **e worker** compatíveis, depois frontend; não ativar o checkout apenas com atualização do frontend. Garantir execução contínua da manutenção de reservas.
3. Homologar com contas reais separadas de cliente/gestor: entrega, retirada, estoque concorrente, reenvio após desconexão, confirmação dentro/fora de dez minutos, cancelamento e isolamento entre lojas.
4. Evoluções separadas: frete, pagamento, integração idempotente pedido→entrega e notificações comerciais.
