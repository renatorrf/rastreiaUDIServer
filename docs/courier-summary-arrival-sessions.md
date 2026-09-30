# Resumo do entregador, avisos de chegada e sessões

## Alterações

- `GET /courier/workdays` mantém os indicadores e acrescenta `deliveries`: até 20 pedidos mais recentes criados hoje, atribuídos ao entregador autenticado, no tenant atual. A data usa o fuso da empresa, como os indicadores existentes. Contém cliente, referência, endereço, situação e horários de criação, coleta e entrega.
- Em Loja de hoje, o resumo aparece abaixo da jornada e permite abrir o pedido. Mantido o tema e os tokens globais; nenhuma biblioteca ou token visual novo.
- Componente compartilhado `CourierCustomerActionsComponent` em Entregas (avulsas) e Rotas (próximo destino): **Cheguei no local** e, depois, **Aguardando na portaria**. Tem processamento visível, bloqueio de duplo toque, timeout de 20 segundos e retentativa com a mesma chave.
- `POST /deliveries/:id/customer-alert`, corpo `{action: 'ARRIVED' | 'WAITING_AT_GATE'}`, requer `Idempotency-Key`, entregador responsável, check-in vigente, entrega IN_ROUTE/NEXT_STOP e, em lote, próximo destino. Não altera o status operacional nem cria ocorrência pendente. Colunas `arrived_at` e `waiting_at_gate_at` persistem os registros e impedem duplicidade mesmo com chaves distintas.
- Auditoria e outbox são gravados na mesma transação. O worker usa Web Push/VAPID configurado por empresa; seleciona exclusivamente inscrições ativas do `customer_profile_id` e tenant da entrega. Não envia WhatsApp/SMS nem broadcasts para outros clientes. Avisos atrasados de pedidos já encerrados são descartados. O cliente precisa estar vinculado ao pedido e ter notificações autorizadas; registro na fila não comprova recebimento no dispositivo.
- Acesso e renovação agora têm prazo padrão de **43.200 segundos (12 horas)** para identidades (cliente/entregador/gestor), acesso operacional e master. `.env` local e `.env.example` atualizados. Erro de rede/servidor na renovação não apaga credenciais; 401 continua encerrando a sessão. Tokens expirados não são aceitos offline. O token curto de liberação da tela master permanece separado e inalterado.

## Publicação coordenada (não executada)

1. Conferir/aplicar as migrações pendentes, incluindo **0051_delivery_customer_alerts.sql**, antes de publicar a nova API. Não há exclusão de dados. Não publicar a API sem as novas colunas.
2. No Cloud Run, definir `ACCESS_TOKEN_TTL_SECONDS=43200` e `REFRESH_TOKEN_TTL_SECONDS=43200`. Variáveis já cadastradas no serviço prevalecem sobre os novos padrões; editar o `.env` local não muda o serviço hospedado.
3. Publicar backend e worker, depois frontend. APK instalado exige nova compilação/sincronização para receber o novo frontend.
4. Fazer novo login para receber tokens com o novo prazo. Tokens emitidos anteriormente conservam sua expiração original; a renovação emite tokens com a configuração nova.
5. Testar no dispositivo de homologação: check-in, iniciar trajeto, chegada, portaria e recebimento no app do cliente vinculado. Conferir que outro cliente não recebe nada. Nenhuma notificação real foi disparada pelos testes automatizados.

## Arquivos principais

- Criados: migration 0051; `delivery-customer-alert.service.ts` e teste PostgreSQL isolado; componente compartilhado de ações e testes; testes de resiliência de sessões.
- Alterados: rotas/consultas de entregas, rotas e jornada; worker de notificações; configuração de TTL; telas Entregas, Rotas e Loja de hoje; serviços de autenticação e relógio de SessionStore.
- Estilo específico limitado à lista compacta de resumos. Botões, feedback, espaçamentos e cores reutilizam o Design System existente; não houve migração global de páginas nem remoção de estilos não relacionados.

## Verificações

- Testes SQL em PGlite (sem conexão ao banco compartilhado): propriedade da entrega, tenant, check-in, sequência, idempotência, privacidade de destinatários e resumo do dia.
- Testes Angular/ChromeHeadless: etapas dos avisos, falha/retry, dupla ação, resumo e navegação, larguras mobile/desktop e renovação de sessão.
- Builds de backend/frontend e lint. Conferência visual interativa local indisponível: o navegador da ferramenta bloqueou a URL local. Validar o fluxo completo no APK/PWA antes da publicação final.
