# Webhook de confirmação Pix — BTG Empresas

## Endpoint para cadastrar após implantação

`POST https://rastreiaudiserver-401137614457.southamerica-east1.run.app/integrations/btg/pix/webhook`

Evento: **instant-collection.paid**. Não cadastrar aqui eventos `payments.confirmed` (outra API), nem usar o callback OAuth `/integrations/btg/callback`.

## Configuração por empresa

1. Aplicar `0069_btg_pix_webhook.sql` (recibos idempotentes e índice de ID por configuração) com a credencial de migração. Aplicada, a pedido do responsável, na base configurada em `.env` em **28/10/2026 01:11:01 UTC** (27/10/2026 22:11:01 em São Paulo). RLS e FORCE RLS verificados; `rastreia_runtime` sem SELECT direto na tabela. Demais ambientes precisam de sua própria aplicação.
2. Publicar backend/worker e frontend. Nenhum deploy foi realizado nesta alteração.
3. No aplicativo BTG de cada empresa, cadastrar o endpoint HTTPS acima e assinar `instant-collection.paid`.
4. Copiar o ID (`webhookId`) e o segredo do webhook do BTG para **Integrações → BTG → Confirmação de pagamentos** da empresa correspondente. Digitar somente o segredo, sem `Bearer`. Não usar Client Secret, chave criptográfica ou segredo de outra empresa. O segredo deve ter 32 a 2048 caracteres sem espaços; o exemplo oficial utiliza UUID de 36 caracteres.
5. Salvar com a senha atual do gestor e autorizar novamente a empresa (o versionamento de configuração existente invalida a autorização anterior). O token exige `openid empresas.btgpactual.com/pix-cash-in`.
6. Manter o worker ativo e homologar com pagamento controlado autorizado pelo responsável. Não houve transação bancária real durante os testes locais.

O endereço é comum, mas **webhookId e segredo são individuais por configuração de empresa**. O mesmo ID não pode ser reutilizado entre duas configurações; para múltiplos recebedores num único aplicativo/webhook seria necessário outro contrato de vínculo explicitamente validado. Campos secretos vazios preservam o valor; campo ID vazio desliga esse webhook sem desativar o polling. Configuração sandbox não autentica eventos que liberem pedidos reais.

## Autenticação e processamento

- Contrato oficial: envelope JSON `{webhookId,event,data}` e cabeçalho `Authorization: Bearer <webhook secret>`. Não inventamos assinatura HMAC. Comparação por hashes de comprimento fixo com `timingSafeEqual`; IDs desconhecidos, segredo incorreto e configurações desativadas não autenticam.
- 200 somente após commit do agendamento ou para evento autenticado sem cobrança elegível. Falha de persistência: 503 para retentativa. JSON inválido: 400; autenticação: 401; corpo acima de 32 KiB: 413. Limite da rota: 120 requisições/minuto/IP, sujeito ao limitador global; calibrar com carga real e proxies confiáveis.
- A empresa é derivada do ID de webhook salvo, nunca de tags do remetente. Cruzamento com empresa, CNPJ recebedor, chave Pix e IDs salvos (cobrança, txId, location). Resultado de criação desconhecido só permite localizar uma cobrança já registrada localmente usando a referência exata `Rastreia <order UUID>` e a mesma conta.
- Recebimento persiste apenas companhia, pedido, data e hash da identidade do evento; não persiste segredo, corpo bruto, dados do pagador ou conta bancária. Reenvios do mesmo evento não reiniciam o backoff. Eventos desconhecidos ou já pagos retornam a mesma resposta sem expor dados.
- Webhook **não altera** pagamento, estoque, entrega ou financeiro. Apenas antecipa `next_check_at`. O worker consulta a API BTG com autorização da empresa e aplica as validações existentes de valor, conta recebedora, IDs e identificação bancária antes de liquidar uma única vez. Não chama URL contida no payload.
- Polling continua como recuperação, inclusive se o webhook não chegar. A janela automática existente é de 7 dias; pagamentos mais antigos exigem conciliação operacional. Pagamentos divergentes, tardios ou de pedidos cancelados permanecem em conferência, sem liberar entrega.
- A API não aguarda uma chamada bancária antes de responder; o BTG documenta 10 segundos para receber a resposta. Timeouts de locks/SQL da transação de recebimento são de 2/4 segundos. Banco indisponível pode provocar timeout/reenvio; recebimento idempotente evita efeitos duplicados.

## Referências oficiais consultadas em 27/10/2026

- [Envelope, Bearer secret, prazo e retentativas](https://developers.empresas.btgpactual.com/docs/starting-doc/Integrando/Webhooks/utilize-webhooks-para-receber-atualiza%C3%A7%C3%B5es-sobre-produtos-conectados)
- [Pix Cobrança e evento instant-collection.paid](https://developers.empresas.btgpactual.com/docs/tecspecs/Banking%20-%20PixCashin-spec)

Sandbox do webhook tem disponibilidade limitada segundo o BTG. Validar a inscrição no console e o recebimento real após publicação; testes isolados não comprovam homologação bancária.
