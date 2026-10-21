# Contratos propostos para vendas por live

Contratos de planejamento, ainda não publicados. Manter o padrão Fastify/Zod e erros `{ error: { code, message, correlation_id } }`. Rotas de tela estão no [plano de implementação](fase-0.md); estes caminhos são de API.

## Regras comuns

- Painel usa bearer existente e tenant derivado de `request.auth`. `storeId` é seleção de recurso, validada no banco; nunca fonte de autorização.
- Operações master usam autenticação master própria. Toda consulta/mutação comercial revalida loja, perfil e capacidade contratada quando aplicável.
- O público conhece slug/token comercial, nunca tenant administrativo ou chave de transmissão. Custos, margem e credenciais não aparecem em DTOs públicos.
- Escritas críticas exigem `Idempotency-Key` de 8 a 100 caracteres. Mesmo conteúdo retorna resultado anterior; conteúdo diferente na mesma chave gera `409`. Guest/cart e master usam escopos de idempotência próprios.
- Edição concorrente usa `expectedVersion`; `409 VERSION_CONFLICT` devolve orientação de recarregar, sem sobrescrever silenciosamente.
- Datas em ISO UTC; moeda BRL e valores em centavos inteiros; quantidades inteiras inicialmente. Produtos fracionados exigirão unidade/precisão próprias antes de habilitar.
- Listas paginadas, limites máximos e filtros de loja/período no servidor. Checkout nunca aceita total/custo calculado pelo browser como verdade.
- Retorno incerto por timeout exige consultar o resultado pela mesma chave, não gerar outra compra/cobrança.

## Catálogo e estoque

| Método e rota | Contrato principal | Autorização |
| --- | --- | --- |
| GET/POST `/commerce/stores/:storeId/products` | Lista; criação com `name`, `sku`, `categoryId`, `priceCents`, `costCents`, variantes | Gestor; leitura operacional limitada sem custo quando necessário |
| PATCH `/commerce/products/:id` | Campos editáveis e `expectedVersion`; arquivamento preserva histórico | Gestor da loja |
| POST `/commerce/products/:id/images` | Upload limitado, assinatura de arquivo validada, metadados removidos | Gestor da loja |
| GET/POST `/commerce/stores/:storeId/categories` | Categorias e ordenação | Gestor da loja |
| GET `/commerce/stores/:storeId/inventory` | Saldo físico, reservado e disponível por variante | Equipe autorizada; custo só gestor |
| POST `/commerce/stores/:storeId/inventory-adjustments` | `variantId`, `delta`, `reason`, `expectedVersion`; movimento auditado | Gestor, confirmação reforçada |
| POST `/commerce/stores/:storeId/imports` | CSV/XLSX, hash e job de validação, sem gravação direta de estoque | Gestor |
| GET `/commerce/imports/:id` | Mapeamento, prévia, erros por linha e resultado | Gestor da loja |
| PUT `/commerce/imports/:id/mapping` | Mapeamento de colunas e versão | Gestor da loja |
| POST `/commerce/imports/:id/confirm` | Política explícita para linhas inválidas, versão e idempotência | Gestor da loja |
| GET `/public/commerce/stores/:slug` | Loja publicada e informações comerciais públicas | Anônimo |
| GET `/public/commerce/stores/:slug/products` | Produtos ativos, preço público, imagens e disponibilidade | Anônimo |

Uploads/importações não devem executar fórmulas da planilha, buscar URLs arbitrárias ou confiar na extensão. Limitar arquivo, linhas e tamanho descompactado; retornar erros sem vazar conteúdo de outra loja.

## Carrinho e checkout

| Método e rota | Entrada e resultado |
| --- | --- |
| POST `/public/commerce/stores/:slug/carts` | Emite posse opaca do carrinho e snapshot, sem exigir cadastro |
| GET `/public/commerce/carts/:id` | Exige posse; devolve itens, versão e totais recalculados |
| PUT `/public/commerce/carts/:id/items/:variantId` | `quantity`, `expectedVersion`, `sourceLiveId?`; zero remove item |
| POST `/customer/commerce/carts/:id/claim` | Identidade autenticada + posse guest; merge transacional por loja |
| POST `/customer/commerce/checkouts` | `cartId`, `expectedCartVersion`, `fulfillment`, `addressId?`, opção de pagamento; retorna pedido/reserva |
| GET `/customer/commerce/orders/:id` | Pedido próprio, pagamento, etapas, eventual entrega/rastreio |
| GET `/customer/commerce/orders` | Histórico próprio paginado; mesmo portal `/cliente` |

Cadastro usa fluxo existente de WhatsApp + senha. Endereço exige seleção validada no Geoapify para entrega; retirada não exige endereço de destino. Nenhuma associação automática por telefone sem autenticação/prova de posse da entrega existente.

Resposta proposta de checkout:

```json
{
  "orderId": "uuid",
  "orderStatus": "PENDING_PAYMENT",
  "paymentStatus": "PENDING",
  "deliveryStatus": "NOT_REQUESTED",
  "currency": "BRL",
  "totalCents": 12990,
  "reservationExpiresAt": "2026-11-01T15:10:00Z",
  "version": 1
}
```

É exemplo de contrato, não pedido real. Se o pagamento for manual, a interface indica isso; não recebe `PAID` sem confirmação autorizada. Revisão de preço retorna `409 CART_CHANGED`; saldo insuficiente, `409 INSUFFICIENT_STOCK`. Carrinho não reserva estoque indefinidamente.

## Pedidos e integração logística

| Método e rota | Responsabilidade |
| --- | --- |
| GET `/commerce/stores/:storeId/orders` | Pendentes por padrão; origem LIVE, CATALOG ou MANUAL, filtro de histórico |
| GET `/commerce/orders/:id` | Itens congelados, cliente, endereço, status e auditoria |
| POST `/commerce/orders/:id/transitions` | `targetStatus`, `expectedVersion`, motivo quando necessário; regras no servidor |
| POST `/commerce/orders/:id/payment-confirmations` | Pagamento manual, valor, referência, motivo; gestor autorizado |
| POST `/commerce/orders/:id/dispatch` | Versão do pedido, entrega/retirada; `202` com solicitação idempotente |
| POST `/commerce/stores/:storeId/dispatch-batches` | IDs de pedidos prontos, validação individual e resultado por pedido |
| GET `/commerce/orders/:id/dispatch` | Pendente, concluído ou erro recuperável, `deliveryId` quando disponível |

Máquina principal: `PENDING_PAYMENT → CONFIRMED → PREPARING → READY_FOR_DISPATCH → IN_DELIVERY → DELIVERED`. Retirada precisa estado próprio de conclusão, sem inventar uma entrega. Cancelamento/estorno têm regras e registros separados. Mudança no preço do produto nunca altera o pedido existente.

Chave logística: `storeId:orderId:deliveryVersion`; constraint única e criação transacional. Um reenvio devolve a mesma entrega. Retornos logísticos atualizam projeção comercial de forma idempotente e não regridem estado por evento atrasado. Código público de pedido não deve colidir com `deliveries.external_reference`, cuja unicidade existente é por tenant.

## Planos e contratação de lives

| Método e rota | Responsabilidade |
| --- | --- |
| GET/POST `/platform/live-plans` | Master lista/cria versão com preço, cota, duração, audiência e qualidade |
| POST `/platform/stores/:storeId/live-subscriptions` | Master ativa contrato com snapshot, vigência e motivo; idempotente |
| PATCH `/platform/live-subscriptions/:id` | Cancelar/alterar próxima vigência com `expectedVersion`; preservar histórico |
| POST `/platform/live-subscriptions/:id/usage-adjustments` | Exceção auditada de cota, período, delta e motivo |
| GET `/commerce/stores/:storeId/live-entitlement` | Situação, limites, uso, saldo, período e motivo de bloqueio |

Referência inicial: `monthlyLiveLimit: 4`, `maxDurationMinutes: 120`, `maxConcurrentViewers: 200`. Preço sugerido para aprovação: `monthlyPriceCents: 149000`, não aplicado automaticamente. Região/tipo de canal são configurações da plataforma, não segredo editável por qualquer unidade.

Ausência de contrato ativo retorna `403 LIVE_ADDON_REQUIRED`; cota esgotada retorna `409 LIVE_QUOTA_EXHAUSTED`. O frontend reflete o motivo, mas backend e worker também impõem os limites. Plano expirado não impede consulta de lives históricas, pedidos e carrinhos. Criar fatura exige decisão explícita; cadastro de pacote não dispara cobrança.

## Sessão ao vivo e estúdio

| Método e rota | Responsabilidade |
| --- | --- |
| GET/POST `/commerce/stores/:storeId/lives` | Listar/agendar sessão com título, horário e playlist |
| PATCH `/commerce/lives/:id` | Editar dados e ordem com versão, sem afetar pedidos |
| POST `/commerce/lives/:id/start` | Validar contrato/cota, reservar consumo e iniciar provisionamento idempotente |
| POST `/commerce/lives/:id/broadcaster-session` | Operador autorizado recebe credencial transitória, somente após autorização de início |
| POST `/commerce/lives/:id/current-product` | `action: NEXT/PREVIOUS/SELECT/HIDE`, `itemId?`, `expectedVersion` |
| POST `/commerce/lives/:id/end` | Confirmação explícita, versão e idempotência; interromper vídeo sem invalidar compras |
| GET `/public/lives/:publicToken` | Snapshot comercial, produto atual, sequência e estado; sem credenciais do apresentador |
| POST `/public/lives/:publicToken/viewer-sessions` | Admissão anônima limitada, lease e playback autorizado |
| POST `/public/live-viewer-sessions/:id/renew` | Prova de posse da sessão; renovar sem consumir nova vaga |

Respostas de credenciais/tokens não são cacheáveis. Visão pública de sessão encerrada oferece catálogo/carrinho. Novos inícios passam pelo relógio e locks do servidor; retomada após falha não ganha mais 120 minutos nem consome outra cota da mesma live.

## Eventos e notificações

Namespace público proposto `/commerce-live`: leitura apenas, sala obtida do token validado. Namespace de operação `/commerce-operations`: salas de lojas autorizadas. Notificação privada usa destinatário autenticado; nunca confiar em roomId enviado pelo cliente.

Envelope comum:

```json
{
  "eventId": "uuid",
  "type": "live.product.changed",
  "aggregateId": "uuid",
  "sequence": 17,
  "effectiveAt": "2026-11-01T15:00:00Z",
  "data": { "itemId": "uuid" }
}
```

Tipos previstos: `live.started`, `live.product.changed`, `live.ended`, `order.created`, `order.status.changed`, `inventory.availability.changed`, `notification.created`. Canal público não recebe dados de comprador, custo, pedido alheio ou tenant interno. Gaps de sequência acionam consulta de snapshot; consumidores e UI deduplicam pelo eventId.

`GET /commerce/notifications` retorna caixa privada paginada. `PATCH /commerce/notifications/:id/read` só altera notificação do usuário atual. Usar mesmo notificationId no banner e push; foreground mostra banner, background pode receber push conforme permissão, com deduplicação entre ambos.

## Financeiro gerencial

`/commerce/stores/:storeId/expenses`, `/expense-categories`, `/expense-allocations` e `/reports/{dre,sales,products,lives}` serão implementados na Fase 5, somente para gestores no escopo autorizado. Despesas incluem competência, pagamento, categoria e rateio validado; relatórios informam período, base e filtros. DRE é gerencial, não documento fiscal. Preço de assinatura do adicional pertence ao billing da plataforma, não à receita de vendas de mercadorias da loja.

## Testes de contrato obrigatórios

- Empresa/loja alheia, entregador e visitante não acessam operações administrativas, custos nem chaves.
- Encerrar live e vencer contrato preservam carrinhos, pedidos, reservas convertidas e snapshots.
- Quatro inícios permitidos e quinto recusado; retries, reconnect, virada do mês e início simultâneo não burlam cota.
- Restrição de duração/audiência funciona no servidor e no provedor, não só na interface.
- Checkout, pagamento e despacho repetidos não geram duplicidade; concorrência não produz saldo negativo.
- Merge de carrinho, importação reprocessada e eventos fora de ordem são determinísticos.
- Falha de push não repete entrega nem notifica outra conta; eventos comerciais não são consumidos silenciosamente pelo worker antigo.
