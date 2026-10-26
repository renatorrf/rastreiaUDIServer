# Publicação do catálogo e produtos de produção

## Comportamento

A publicação tem dois comandos independentes: disponibilizar o catálogo da unidade e habilitar cada produto. A tela apresenta os passos 1 e 2, o estado salvo do catálogo e o motivo de um produto permanecer oculto (publicação individual, produto/categoria arquivados ou ausência de variante ativa).

Saldo zero não oculta produtos. Para produtos `STOCKED`, o catálogo indica indisponibilidade e o servidor recusa quantidades maiores que o saldo livre. Em `MADE_TO_ORDER` (Produzido sob encomenda), todas as variantes ativas permitem inclusão no carrinho independentemente do saldo físico, com o mesmo limite de 99 unidades por variante. Não há baixa nem reserva de estoque nesta fase.

O gestor escolhe a modalidade em Vendas → Catálogo → Editar produto → Disponibilidade do produto. O padrão permanece `STOCKED`; nenhum produto existente é convertido automaticamente. Clientes antigos/importações que omitem o campo preservam a modalidade já salva.

Os requisitos de publicação, categoria, variante, unidade e empresa ativas continuam valendo. Alterar de produção para estoque revalida o carrinho na próxima leitura e informa saldo insuficiente sem apagar os itens.

## Implantação

Migração `0057_commerce_production_products.sql` **aplicada na base configurada em 23/10/2026 às 22:36 (Brasília)**, junto da dependência pendente `0056_commerce_guest_carts.sql`. Nova conexão confirmou 57 migrações e nenhuma pendência. A coluna `stock_mode` está NOT NULL com padrão `STOCKED`; produto, variante e saldos existentes foram preservados. RLS, privilégios e consultas públicas/carrinho foram conferidos com o papel runtime, sem criar dados fictícios.

A etapa de banco está concluída. Publicação do backend, frontend/Firebase e sincronização do Android permanecem etapas separadas, mediante autorização. Não alterar as migrações anteriores. Nenhum ajuste de `.env` é necessário.

## Arquivos e design

- Backend: `commerce.schemas.ts`, `commerce.service.ts`, migração 0057 e testes de integração.
- Frontend: tipos da API, formulários de catálogo/publicação, indicação pública de produção e testes comerciais.
- O layout mantém o tema existente e usa os tokens e classes globais; a organização em dois passos segue a skill de frontend. Nenhum token, biblioteca ou componente compartilhado novo foi necessário. Estilos da publicação ficam no módulo comercial existente; não houve remoção de CSS de outras telas.

## Validação local

- Backend: build, lint e 84 testes comerciais aprovados, com execução das funções SQL do catálogo/carrinho e RLS.
- Frontend: build de produção e 31 testes comerciais aprovados.
- Navegador: publicação separada da habilitação, estado durante gravação, formulário de produção em modal mobile, console sem erros e larguras 320, 375, 390, 430, 768, 1024 e 1280 sem transbordamento horizontal na publicação.
- Evidência visual local: `rastreia-front/rastreiaApp/.data/commerce-evidence/publicacao-dois-passos.png`.

Checkout e geração de pedidos permanecem fora desta etapa. Esta validação local não representa implantação nem teste do APK instalado.

## Identidade por unidade — 26/10/2026

- Migração **0064_commerce_store_identity.sql preparada, não aplicada ao banco compartilhado**. Executar pelo processo normal de migrations antes de implantar este backend; não altera os registros existentes nem exige cadastrar logos para lojas antigas.
- Publicação recebe `hasLogo`/`logoVersion`; a chave privada do objeto não é devolvida no JSON. Catálogo e snapshot da live recebem somente a versão pública (zero quando não há logo).
- Gestor autorizado à unidade envia JPEG/PNG/WebP de até 5 MB em `POST /commerce/stores/:storeId/storefront/logo?expectedVersion=N`, com `Idempotency-Key`; consulta autenticada por GET e remoção lógica por PATCH `{remove:true,expectedVersion:N}`. Reutiliza RLS, validação real/otimização de imagem, auditoria, storage e controle de versão do catálogo.
- Endpoint público `/public/commerce/stores/:slug/logo` só serve imagem de catálogo publicado com unidade/empresa/tenant ativos. A remoção e a despublicação impedem novas consultas públicas; cache HTTP `no-store`.
- A imagem é convertida para WebP de até 400 px sem recorte, preservando proporção. Não há configuração de logo no `.env`. Reutiliza o object storage já configurado para imagens de produtos; em hospedagem com disco efêmero, manter storage persistente configurado.
- Remover/substituir a logo desvincula a imagem antiga, sem exclusão física automática. Objetos anteriores ficam para uma futura política de limpeza segura; não são acessíveis pelo endpoint de logo.
- Validação isolada: 128 testes comerciais/segurança/SQL aprovados, build e lint dos arquivos alterados aprovados. Nenhuma escrita na base real, publicação ou configuração de AWS realizada.
