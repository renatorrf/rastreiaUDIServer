# Fase 1D — carrinho persistente do catálogo público

Implementação local em 21/10/2026. **Migração 0056 aplicada ao banco configurado em 23/10/2026, como dependência da 0057 autorizada. Sem deploy nesta execução.**

## Comportamento entregue

- Adicionar uma variação pelo catálogo `/loja/:slug`, ajustar quantidades, remover itens e consultar subtotal em BRL. Cabeçalho e barra inferior abrem o carrinho; modal no celular e painel lateral a partir de 1200 px, mantendo o tema e os componentes existentes.
- O carrinho é criado no servidor na primeira inclusão, com identidade de visitante própria, sem conta de usuário compartilhada. Preços e totais vêm exclusivamente do servidor.
- Carrinhos separados por unidade. Até 50 variações, até 99 unidades por variação. Adicionar não reserva nem baixa estoque; o saldo é conferido ao alterar a quantidade e novamente ao consultar o carrinho.
- Mudanças de preço são sinalizadas. Itens despublicados, arquivados, sem saldo ou de loja indisponível permanecem visíveis com aviso, usando o nome/preço anteriormente registrado quando não estão mais públicos. O cliente pode removê-los; nada é retirado automaticamente.
- Após 30 dias sem alteração, o carrinho exige revisão explícita. A revisão renova a validade e atualiza preços públicos sem excluir itens indisponíveis. Nenhum job de exclusão foi criado.
- Estados de processamento, controles contra clique duplo, timeout de leitura/escrita já existente e ação de tentar sincronizar. Fechar/reabrir o carrinho preserva os itens.

## Persistência e recuperação

O servidor é a fonte oficial. IndexedDB com Dexie mantém a posse, o último snapshot confirmado e uma alteração pendente por loja. O dispositivo gera um token opaco aleatório de 256 bits antes da primeira chamada; a API armazena somente SHA-256 desse token. A criação é idempotente pela posse e unidade, e as alterações usam uma chave de idempotência própria persistida antes do envio.

Após timeout, queda de conexão ou erro 5xx, a alteração e sua chave permanecem no dispositivo. A reconexão/retorno à aba ou o botão de sincronizar repete a mesma operação. O servidor reconhece o replay e devolve o estado atual, evitando incrementos duplicados mesmo quando a resposta anterior foi perdida depois do COMMIT.

Falhas definitivas de validação/versão não são repetidas automaticamente. O snapshot atual é recuperado para o cliente revisar. Em duas abas, o espelho local usa transação para preservar uma alteração pendente, e o servidor bloqueia a linha do carrinho e exige `expectedVersion`. Uma aba com versão antiga recebe conflito em vez de sobrescrever a outra.

Se IndexedDB estiver bloqueado ou sem espaço, o fluxo continua na memória da aba com aviso para mantê-la aberta. Limpar os dados do navegador ou trocar de dispositivo não permite recuperar a posse anônima automaticamente. Associação/merge com a conta do cliente pertence à Fase 2; navegar ao login e retornar no mesmo dispositivo preserva o carrinho visitante.

## API e banco

Todas as rotas recebem a posse somente no header `X-Commerce-Cart-Token`, sem token no endereço, cookie ou credencial de gestor. Escritas exigem `Idempotency-Key`. Respostas `Cache-Control: no-store`; o header de posse está redigido nos logs da aplicação.

| Método e rota | Comportamento |
| --- | --- |
| POST `/public/commerce/stores/:slug/carts` | Corpo `{}`, cria/retoma o carrinho dessa posse na loja publicada |
| GET `/public/commerce/carts/:id` | Confere posse e recalcula disponibilidade, preços e subtotal |
| PUT `/public/commerce/carts/:id/items/:variantId` | `quantity` e `expectedVersion`; quantidade zero remove o item |
| POST `/public/commerce/carts/:id/refresh` | `expectedVersion`; revisão explícita sem perda de itens |

O cliente não envia preço, total, custo, tenant ou unidade administrativa. Inclusão confere produto, variante, categoria, loja, empresa e tenant ativos/publicados. RLS forçada nas três novas tabelas, sem acesso direto do runtime: leitura/escrita passam por funções SECURITY DEFINER com posse, chaves compostas e projeção pública limitada. O proprietário dessas funções deve conservar o padrão das migrações anteriores.

Nenhuma tabela de live é referenciada: carrinho e futuras lives têm ciclos independentes. Não são criados pedido, reserva, pagamento, evento outbox ou entrega nesta etapa. A tela informa que a finalização da compra virá depois.

## Validação

- Backend: build/lint aprovados, suíte geral com 296 testes aprovados, seguida do novo teste de ponta a ponta HTTP + funções PostgreSQL em PGlite; módulo comercial completo com **78 testes aprovados**. Cobertura inclui repetição, preço autoritativo, versão antiga, posse incorreta, segregação de lojas, despublicação, expiração/revisão, quantidade indisponível e ausência de reserva.
- Frontend: build de produção, lint dos arquivos alterados e **323 testes aprovados**. Testes reais de IndexedDB cobrem identidade concorrente, fila entre abas e preservação da alteração pendente. Testes de serviço cobrem restauração, offline, perda da resposta após gravação, conflito de versão e navegação para outra loja durante uma leitura lenta de identidade local.
- Navegador: páginas reais com API fictícia isolada; inclusão de duas variações, quantidade, falha simulada após gravação, retry sem duplicação e refresh com recuperação dos três itens/subtotal conferidos. Layout verificado em 320, 375, 390, 430, 768, 1024 e 1280 px sem overflow horizontal. Troca modal/painel corrigida para o Ionic concluir o fechamento e restaurar acessibilidade; testes existentes do editor continuam aprovados.
- A prévia usa armazenamento fictício separado da API real e não acessa o banco configurado. Não comprova deploy, concorrência real com várias conexões PostgreSQL 9.6 ou uso em APK/dispositivo físico.

## Ativação e próxima etapa

1. **0056 e 0057 aplicadas em ordem em 23/10/2026 às 22:36 (Brasília)** após conferência do destino e das pendências. Nova conexão confirmou 57 migrações e nenhuma pendência.
2. Validadas as três tabelas com RLS forçada e sem privilégios diretos para o runtime, além dos privilégios das funções no PostgreSQL 9.6.24 configurado. Nenhum carrinho fictício foi criado; produto, variante e saldos existentes foram preservados.
3. Publicar backend e frontend; conferir preflight CORS para `X-Commerce-Cart-Token`, `Idempotency-Key` e PUT na origem Firebase/APK já autorizada. Não há nova variável de ambiente.
4. Homologar com produtos autorizados: visitante sem login, duas abas, refresh, reconexão, erro de versão, estoque alterado e catálogo oculto. Não usar este carrinho como comprovação de reserva ou pedido.
5. A Fase 2 adiciona identificação/merge transacional com a conta existente, checkout, retirada/entrega, reservas com expiração, pedidos e notificações. Não há botão de checkout funcional nesta entrega.

Prévia: comandos em `fase-1a.md`, rota `/loja/unidade-centro`. O botão **Simular falha** existe somente no bootstrap de demonstração, não na aplicação de produção.
