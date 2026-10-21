# Fase 1B — variantes, estoque e publicação (recorte entregue)

Implementação local de 21/10/2026, conforme o recorte solicitado: estoque, variantes e publicação. Não encerra toda a Fase 1B planejada: imagens, importação e carrinho continuam pendentes. A migração 0054 foi aplicada posteriormente mediante autorização explícita, conforme registro abaixo. Não houve deploy nem publicação de catálogo real.

## Menus e uso

- **Vendas → Catálogo:** cada produto tem o atalho **Variantes / estoque**.
- **Vendas → Estoque e variantes** (`/app/vendas/estoque`): busca por produto/SKU, filtro ativo/arquivado e estoque baixo/sem disponível, paginação e histórico por variante.
- **Vendas → Publicação do catálogo** (`/app/vendas/publicacao`): título, apresentação, endereço estável e publicação explícita da unidade; exibição individual dos produtos.
- Catálogo público em **`/loja/:slug`**, sem autenticação e somente para consulta. Não aceita pedidos nem pagamentos nesta etapa.

Administração restrita ao gestor autorizado da unidade, também no servidor e no RLS. Operador e entregador não têm acesso aos custos, saldos ou configurações comerciais. O master mantém os menus de pacotes já entregues, sem novo acesso implícito ao estoque das unidades.

## Variantes e estoque

- Produto existente ou novo recebe a variante **Padrão**, inicialmente com saldo zero. SKU, preço e custo da padrão acompanham o cadastro do produto; ela pode ser arquivada para trabalhar somente com variantes específicas.
- Variantes têm nome, SKU único por unidade, cor/tamanho opcionais, preço e custo próprios, mínimo e situação. Limite de 100 variantes por produto; valores monetários inteiros em centavos.
- Físico, reservado e disponível são separados. Nesta etapa não há API de reserva: o reservado permanece zero; checkout futuro usará a mesma proteção de saldo.
- Entrada, saída, perda, consumo, devolução e ajuste exigem motivo e senha atual do gestor. Quantidades inteiras; bloqueio de saldo negativo/abaixo do reservado e de saldo acima de 1.000.000.
- A movimentação bloqueia a linha do saldo e exige versão esperada. Saldo e histórico são atualizados na mesma transação; idempotência impede duplicação em retry da mesma operação.
- Runtime não pode atualizar saldos diretamente nem editar/apagar movimentos. Somente a função controlada realiza a movimentação e deriva o autor da sessão.
- Correção é outro movimento, nunca alteração do histórico. Arquivar variante preserva seu estoque e histórico.
- A senha não entra na auditoria nem no hash/registro de idempotência; campo limpo após concluir/falhar/fechar. Tentativas de confirmação limitadas por rota.

## Publicação e privacidade

O catálogo inicia fora do ar e os produtos iniciam não publicados. A loja deve salvar o endereço e marcar a publicação; cada produto deve ter a exibição habilitada. O slug é globalmente único e não muda depois de salvo.

A projeção pública exige tenant, empresa e unidade ativos, publicação da unidade e produto, produto/categoria ativos e pelo menos uma variante ativa. Retorna somente apresentação, categoria, nomes, atributos, preços de venda e disponibilidade booleana. Não retorna custo, saldo físico/reservado/mínimo, SKU interno, identidade do gestor ou dados privados da unidade. Arquivar ou ocultar retira o item de futuras consultas.

Listagem pública paginada (20 padrão, máximo 50), busca/categoria, limitação de requisições e `Cache-Control: no-store`. Service Worker não inclui cache da API. Acesso público usa funções de projeção específicas, sem política pública de SELECT das tabelas privadas. Uma página que já estava aberta precisa atualizar para refletir uma alteração; realtime comercial ainda não foi implementado.

O link administrativo é construído pelo backend a partir da origem de **`PUBLIC_TRACKING_BASE_URL`**, que deve apontar ao frontend público (Firebase/domínio próprio), nunca ao backend. Isso evita links `localhost` no APK. Sem base válida, a tela informa que o endereço público precisa ser configurado. Não foram lidas ou alteradas credenciais nesta entrega.

## API adicionada

Escritas autenticadas exigem `Idempotency-Key` e, nas edições, versão esperada. Nenhum payload aceita tenant/autor arbitrários.

- `GET/POST /commerce/stores/:storeId/products/:productId/variants`
- `PATCH /commerce/stores/:storeId/products/:productId/variants/:id`
- `GET /commerce/stores/:storeId/inventory` (busca, situação, saldo, produto e paginação)
- `GET /commerce/stores/:storeId/inventory/:id/movements` (histórico paginado)
- `POST /commerce/stores/:storeId/inventory-adjustments` (senha, tipo, quantidade, motivo e versão do saldo)
- `GET/POST /commerce/stores/:storeId/storefront`
- `PATCH /commerce/stores/:storeId/products/:productId/publication`
- `GET /public/commerce/stores/:slug`
- `GET /public/commerce/stores/:slug/products`

## Migração e ativação

**Aplicada: `0054_commerce_inventory_storefront.sql`, em 21/10/2026 às 17:22:50 (America/Sao_Paulo), mediante autorização explícita.** Adiciona o sinalizador de publicação em produtos, quatro tabelas, índices, RLS forçada, triggers e funções de movimentação/projeção. Triggers usam `EXECUTE PROCEDURE` para compatibilidade com PostgreSQL 9.6. Não exclui registros, não altera usuários/entregas e não presume estoque inicial.

Verificação em nova conexão ao banco configurado (PostgreSQL 9.6.24): **54 migrações aplicadas, nenhuma pendente**. Confirmados RLS habilitada/forçada nas quatro tabelas, cinco funções SECURITY DEFINER, dois triggers e publicação com padrão false. Não havia produtos antes da execução; produtos e novas tabelas permanecem vazios. O runtime não possui escrita direta nos saldos nem no histórico; execução de ajuste sem identidade foi negada (42501), e a consulta pública de catálogo inexistente retornou NULL. Não foi criado catálogo, estoque fictício ou registro operacional de teste. Esta verificação não substitui homologação de concorrência ou E2E.

1. Em janela autorizada, conferir backup, destino e pendências; 0053 já foi aplicada ao banco configurado na entrega anterior.
2. No banco configurado, 0054 já aplicada. Em outros ambientes, validar e aplicar com credencial de migração. `npm run db:migrate` aplica **todas** as pendentes; conferir a lista antes. O backend novo seleciona `commerce_products.published`, portanto 0054 deve anteceder seu deploy.
3. Publicar backend, validar autenticação/isolamento e saldo em homologação; publicar frontend em seguida. Confirmar `PUBLIC_TRACKING_BASE_URL`, CORS e rota SPA `/loja/:slug` no Hosting.
4. Criar um produto autorizado, conferir variante padrão, registrar entrada e saída, tentar saldo negativo e edição com versão antiga; validar histórico.
5. Publicar um catálogo de teste e apenas os produtos autorizados; consultar anônimo e confirmar retirada após ocultar/arquivar e suspensão da unidade.

Não modificar os privilégios do runtime para contornar erro de migração. O proprietário das funções SECURITY DEFINER precisa manter o padrão de execução das migrações existentes. Reversão operacional: voltar aplicação compatível e retirar catálogo do ar; manter tabelas/histórico, sem DROP/TRUNCATE ou promessa de rollback automático.

## Validações e limites

- Backend: build, lint e **257 testes aprovados** em 50 arquivos (`npx vitest run --maxWorkers=2`); testes de migrations/serviços/RLS em PGlite, mais testes HTTP de autenticação, perfil, confirmação de senha, escopo e rate limit.
- Frontend: build de produção, lint dos arquivos alterados e **303 testes aprovados** no ChromeHeadless; validação de sinal/quantidade, duplicidade, password cleanup, troca de unidade com falha, publicação e catálogo indisponível.
- Prévia local usa páginas reais e API fictícia, sem acesso à base real. Modal móvel, estado ocupado, movimentação, publicação explícita e visibilidade individual exercitados pelo navegador. Layout conferido de 320 a 1280 px.
- PGlite não comprova concorrência com várias conexões nem compatibilidade executada no PostgreSQL 9.6 do provedor. Validar ambos antes de estoque comercial real.
- Sem testes publicados no Firebase/APK, pedidos online, reservas, imagens/upload, importação, vídeo AWS, faturamento ou notificações comerciais. Nenhum evento novo foi colocado no outbox enquanto o dispatch do worker não for evoluído.

Prévia reproduzível: comandos em `fase-1a.md`, rotas `/estoque`, `/publicacao` e `/loja/unidade-centro`. Os dados de demonstração não persistem e não são importados pela aplicação de produção.
