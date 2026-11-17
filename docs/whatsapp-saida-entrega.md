# WhatsApp de saída da entrega — R3 Labs

Implementação local. Não houve migração na base compartilhada, publicação ou envio real nesta etapa.

## Contrato aprovado pelo solicitante

- Remetente exclusivo R3 Labs, usando credenciais globais do servidor. Não usa nem altera as credenciais das empresas.
- Template `rastreia_app_pedido`, parâmetros posicionais no BODY:
  1. primeiro nome do destinatário;
  2. referência externa do pedido, ou primeiros oito caracteres do ID;
  3. nome da unidade;
  4. URL individual de acompanhamento;
  5. URL da área do cliente.
- Idioma padrão `pt_BR`: conferir o idioma efetivamente aprovado na Meta.
- Sem previsão de entrega. O texto fixo e a assinatura são definidos no template da Meta, não enviados como texto livre.
- Se houver HEADER dinâmico ou botão URL dinâmico na versão aprovada, adaptar o contrato antes de ativar. Esta versão envia cinco parâmetros BODY e nenhum parâmetro de botão/header.

## Eventos e isolamento

1. Entrega individual: `transitionDelivery(..., 'start')` grava `delivery.start` no outbox na transação operacional.
2. Lote: `startRoute` grava `delivery.start` para cada destino coletado. Cada cliente recebe seu próprio pedido/link. `delivery.next-stop`, reordenação e prioridade não repetem o aviso.
3. O worker enfileira o WhatsApp antes de processar push; falha/retry de push não cria outro aviso.
4. Só envia durante `IN_ROUTE` ou `NEXT_STOP`, com entregador atribuído e saída registrada. Revalida empresa, tenant e unidade ativos, telefone exato, token e remetente antes de chamar a Meta.
5. Eventos de saída com mais de 30 minutos não disparam novos avisos ao religar um worker parado. Não há backfill de entregas históricas.
6. Criação, atribuição, coleta, chegada, conclusão, cancelamento, falha ou devolução não disparam este template.
7. Pedido iFood sem telefone fica `SKIPPED`; nunca usa telefone da loja, entregador ou outro cliente. Coletar telefone depois da entrega não dispara “está a caminho”.

## Duplicação e falhas

- Lock da entrega e índice único por tenant/entrega/canal/finalidade. Botão manual e automático compartilham a mesma mensagem lógica.
- API manual devolve o aviso existente se já está na fila, enviado, entregue ou sem confirmação. Duplo clique/retry de HTTP não produz nova mensagem.
- Retry automático apenas para HTTP 429 (rejeição por limite); usa o backoff/limite do outbox existente.
- Timeout, resposta 5xx ou sucesso sem ID ficam `UNKNOWN`. Não há garantia de exactly-once entre banco e API externa; prioriza-se não duplicar uma mensagem possivelmente aceita.
- Worker interrompido com mensagem `PROCESSING` transforma-a em `UNKNOWN` ao recuperar o trabalho, sem novo POST.
- HTTP 4xx definitivo fica `FAILED`; pode haver tentativa manual após correção, somente quando não há ID aceito pelo provedor. Mensagem com ID do provedor requer revisão, sem botão de reenvio automático.
- Webhook com assinatura HMAC válida e Phone Number ID correspondente atualiza `SENT`/`DELIVERED`/`FAILED`. O campo `biz_opaque_callback_data` permite conciliar uma resposta perdida com a mensagem local.
- Webhooks repetidos são idempotentes. `sent`/`failed` atrasados não rebaixam `DELIVERED`.
- Não há fallback de WhatsApp para SMS. Trabalhos WhatsApp legados de um parâmetro ficam suspensos para revisão, sem conversão silenciosa para o novo contrato.
- URL e destinatário ficam no payload criptografado. Logs/outbox/auditoria não recebem token de rastreio, número completo ou credenciais.

## Links

A migração 0072 substitui o índice de um único token ativo por um índice não único. Gerar link manual ou para o WhatsApp mantém links anteriores válidos até o vencimento. A ação explícita “Revogar links” continua revogando todos os links da entrega. O worker não envia um token já revogado/expirado.

## Ativação coordenada

1. Aplicar `0072_automatic_tracking_whatsapp.sql` com o processo de migração do projeto. Conferir previamente duplicatas não nulas de `message_deliveries.provider_message_id` (o índice único não elimina dados automaticamente).
2. Configurar API e worker com o mesmo `MESSAGE_PAYLOAD_SECRET` e `TRACKING_TOKEN_PEPPER` existentes. Não regenerar essas chaves.
3. Configurar credenciais do número R3 Labs via Secret Manager/ambiente seguro:
   - `WHATSAPP_PHONE_NUMBER_ID` (ID da Meta, não o telefone escrito);
   - `WHATSAPP_ACCESS_TOKEN`;
   - `WHATSAPP_APP_SECRET` (validação HMAC do webhook);
   - `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (verificação do callback).
4. Configuração não secreta:

```dotenv
WHATSAPP_DELIVERY_STARTED_TEMPLATE=rastreia_app_pedido
WHATSAPP_TEMPLATE_LANGUAGE=pt_BR
WHATSAPP_CUSTOMER_APP_URL=https://rastreiaudi.web.app/cliente
PUBLIC_TRACKING_BASE_URL=https://rastreiaudi.web.app/rastrear
COMMUNICATIONS_MOCK=false
WHATSAPP_AUTOMATIC_TRACKING_ENABLED=false
```

5. Publicar backend/worker e frontend de forma coordenada. O APK distribuído anteriormente não contém a nova interface; precisa de novo build quando autorizado.
6. Configurar na Meta o callback existente:
   `https://rastreiaudiserver-401137614457.southamerica-east1.run.app/webhooks/whatsapp`
   Verificação GET e recebimento POST, com eventos/status de mensagens da conta R3 Labs.
7. Confirmar template aprovado, cinco parâmetros, idioma e autorização dos destinatários para receber avisos transacionais. Fazer teste autorizado com número controlado, primeiro pelo botão manual numa entrega de teste em trajeto.
8. Só depois habilitar `WHATSAPP_AUTOMATIC_TRACKING_ENABLED=true` na API/worker e observar uma entrega individual e um lote. Não testar disparando em pedidos reais sem autorização.

As quatro credenciais globais estavam vazias no `.env` local inspecionado, sem exibir valores. Estado do Cloud Run não foi consultado/alterado.

## Interface e validação

Tela de entregas: estado do WhatsApp sempre visível no inspetor, inclusive histórico concluído. Ações de envio/link e histórico ficam em accordions nativos (`details/summary`), mantendo botões existentes. Polling a cada 10 segundos com página visível, atualização manual, skeleton, tratamento de erro e proteção contra respostas atrasadas de outro pedido.

Usa tokens/cores/botões/status do Design System existente; nenhum token ou biblioteca foi adicionado. CSS local restrito à composição desta seção. Sem alterações no menu/split pane.

Arquivos principais novos: migração 0072, `tracking-whatsapp.service.ts`, teste de integração e este guia. Alterados: configuração, fila manual, worker, webhook e emissão de links. Frontend: modelo/API, página de entregas e testes; QA isolado em `scripts/verify-whatsapp-notice.cjs`.

Testes isolados PostgreSQL (PGlite) e HTTP simulado cobrem deduplicação, escopo, invalidação, atraso, falta de telefone/configuração, estados terminais, retomada, 429, timeout/5xx e assinatura/webhook fora de ordem. Nenhuma conexão a banco compartilhado ou envio real foi feita.

Referências do contrato da Meta:
- https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/
- https://www.postman.com/meta/whatsapp-business-platform/request/2qbotrb/send-message-template-media
