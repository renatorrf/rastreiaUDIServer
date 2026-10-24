# Catálogo da unidade no histórico do cliente

Implementação local em 23/10/2026. Migração **0058 aplicada à base configurada em 23/10/2026, mediante autorização**. Sem deploy.

## Regra

- Nos pedidos `DELIVERED`, remover **Acompanhar pedido**, **Refazer pedido**, **Falar com a loja** e o aviso de WhatsApp indisponível.
- Se o catálogo da unidade estiver público, mostrar uma única ação **Ver catálogo da loja**, que navega internamente para `/loja/:slug`. Sem catálogo, o card permanece somente para consulta.
- Pedidos ainda não entregues preservam as ações anteriores. A mudança não cria pedidos nem finaliza compras: o catálogo/carrinho existente continua com checkout pendente da próxima fase.

## Segurança e contrato

`GET /customer/orders` passa a incluir `storeCatalogSlug: string | null`. A migração `0058_customer_order_catalog.sql` cria `customer_orders_with_catalog(uuid)`, que enriquece exclusivamente o resultado das funções existentes de histórico autorizado (identidade global ou sessão legada).

O vínculo é feito por unidade **e tenant** da entrega; a disponibilidade usa `commerce_public_store`, incluindo publicação e status ativo de loja, empresa e tenant. Não se escolhe um catálogo por nome ou WhatsApp. Não há acesso direto novo às tabelas comerciais, nem mudança nas políticas RLS ou nas funções de histórico anteriores. Nenhum dado cadastrado é publicado pela migração.

## Arquivos

- Backend: nova migração 0058; rota `customer.routes.ts`; testes HTTP/SQL em `customer-activation.integration.test.ts` com as migrações reais de clientes e catálogo.
- Frontend: contrato `CustomerOrder`, template e teste de `CustomerPortalPage`. Mantidos componentes, classes e tema existentes; nenhum CSS ou token novo.

## Implantação

1. **Etapa de banco concluída:** 0058 era a única pendência e foi aplicada. Nova conexão confirmou 58 migrações e nenhuma pendência no PostgreSQL 9.6.24.
2. Publicar backend e frontend. O frontend tolera backend antigo sem o campo, ocultando o botão do catálogo.
3. Validar pedido entregue com catálogo publicado/despublicado, unidade inativa e pedido em rota. Verificar também o retorno pelo botão voltar após abrir o catálogo.

O catálogo continua verificando sua disponibilidade ao abrir. Se for despublicado depois de carregar o histórico, a página pública informa indisponibilidade; atualizar os pedidos remove o botão.

## Validação local

- Backend: build e lint dos arquivos alterados aprovados; 100 testes dos módulos clientes/comercial aprovados, incluindo a API de histórico com SQL real em PGlite, catálogo ausente/despublicado, loja/empresa/tenant inativos, segregação por tenant e usuário e histórico legado autorizado.
- Frontend: build de produção, TypeScript/templates, lint e 9 testes do portal aprovados em Chrome Headless. O teste verifica botão único e URL da unidade, ausência das ações antigas e preservação do acompanhamento para pedido em rota.
- Os testes locais não usaram o banco configurado nem criaram dados reais. Após autorização, a migração 0058 foi aplicada ao banco configurado e validada em nova conexão: função SECURITY DEFINER, search_path fixo, proprietário com bypass RLS, EXECUTE permitido ao runtime e revogado de PUBLIC. Consultas sem identidade/sessão autorizada retornaram zero linhas, em transação somente leitura.
- Homologação em celular e publicação de backend/frontend permanecem pendentes. Nenhum deploy foi realizado.
