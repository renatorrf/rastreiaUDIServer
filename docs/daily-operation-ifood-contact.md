# Operação diária e contato do cliente iFood

## Comportamento

- Entregas e Rotas abrem em **Hoje**, com filtro no servidor antes da paginação, no fuso da empresa. Entregas consideram a data de criação; rotas, o início planejado ou a criação quando não houver planejamento.
- **Pendentes** mantém acesso às atividades abertas de qualquer data, inclusive anteriores e agendadas. Assim, a virada do dia não impede a conclusão de uma atividade.
- **Histórico** reúne registros encerrados, com paginação de 50 itens e detalhes somente para consulta. Ações de operação, envio e alteração de ocorrências ficam ocultas; dados, comprovantes e eventos permanecem disponíveis.
- O formulário de nova entrega tem apenas **WhatsApp**, sem o campo Telefone duplicado. O mesmo número normalizado alimenta ambos os campos do contrato existente da API.
- Ao concluir uma entrega iFood sem WhatsApp, o entregador recebe uma sugestão opcional para solicitar o contato ao cliente. A etapa pode ser dispensada e não bloqueia a conclusão. Nas rotas, não aparece ao iniciar o trajeto: somente após concluir o destino.
- O contato coletado vincula o pedido a um perfil existente da mesma empresa ou prepara um pré-cadastro com os dados da entrega. Não cria senha, usuário autenticado nem consentimento em nome do cliente. A ativação continua no fluxo WhatsApp + senha.
- O backend mantém autorização por empresa/unidade/entregador, idempotência, validação do estado DELIVERED e proteção contra substituir um WhatsApp já vinculado por outro número.

## Arquivos e Design System

Caminhos de frontend relativos a `rastreia-front/rastreiaApp`:

- Criado `src/app/shared/operational-list-toolbar.component.ts`: navegação Hoje/Pendentes/Histórico e paginação compartilhadas.
- Criado `src/app/pages/routes/routes.page.spec.ts`: consultas, histórico somente leitura, responsividade e momento da sugestão iFood.
- Alterados `src/app/pages/deliveries/deliveries.page.ts`, `.html` e `.spec.ts`: filtros, formulário, consulta e testes.
- Alterados `src/app/pages/routes/routes.page.ts` e `.html`: filtros, consulta, acesso direto à rota e sugestão após conclusão.
- Alterado `src/app/core/api/operations-api.service.ts`: parâmetros das listagens e consulta individual de rota.
- Alterado `src/app/core/driver-events/driver-event-panel.component.ts`: modo somente leitura, preservando os eventos.
- Alterado `src/app/core/deliveries/ifood-whatsapp-prompt.component.ts`: orientação opcional ao entregador.
- Alterado `scripts/preview-workday.mjs`: dados sintéticos para prévia local dos novos estados.

Caminhos de backend:

- `src/modules/deliveries/delivery.service.ts` e `delivery.routes.ts`: filtros diários/paginação e pré-cadastro ao coletar o contato.
- `src/modules/routes/route.service.ts` e `route.routes.ts`: filtros, paginação e consulta individual autorizada.
- `src/modules/customers/customer-activation.integration.test.ts`: contato iFood, isolamento, replay, validações e recorte diário em PostgreSQL/WASM isolado.
- `test/route-list.test.ts`: parâmetros e SQL da consulta de rotas.

Nenhum token novo, biblioteca ou tema foi adicionado. As duas telas reutilizam o tema escuro/verde, classes globais e componentes Ionic existentes. O padrão repetido de navegação/paginação foi concentrado no componente compartilhado; não houve reescrita dos estilos das páginas nem migração de outras telas.

## Validação em 30/09/2026

- Build backend e build de produção frontend: aprovados, incluindo TypeScript, imports e templates.
- Backend: 169 testes aprovados em 40 arquivos; lint aprovado.
- Frontend: 213 testes aprovados em ChromeHeadless; lint dos arquivos TypeScript alterados aprovado.
- Testes de renderização cobrem larguras móveis/desktop, registros longos, formulário, histórico sem ações e sugestão após conclusão.
- Há mensagens já existentes de `ion-menu` sem content nos fixtures isolados; não se afirma console global limpo.
- Inspeção manual no navegador interativo não concluída: a prévia local foi bloqueada por `ERR_BLOCKED_BY_CLIENT`. Validação visual final no aparelho permanece recomendada.
- Sem uso de pedidos reais, envio de notificações, alteração de credenciais, migração remota ou deploy nesta alteração.

## Publicação

Publicar backend e frontend compatíveis. Esta alteração não cria migration adicional, mas o fluxo de pré-cadastro/WhatsApp depende da migration existente **0050_customer_whatsapp_login.sql**. Conferir sua aplicação antes de publicar; ela não foi executada nesta etapa. Ver também `customer-whatsapp-access.md`.
