# Checkout Pix BTG e taxa fixa por unidade

## Entrega desta etapa

- Migração **0067_commerce_pix_checkout.sql** aplicada em etapa anterior. A nova **0068_commerce_store_approval.sql** está preparada/testada isoladamente, ainda não aplicada ao banco compartilhado.
- Taxa de entrega em centavos por unidade. Retirada custa zero. A taxa é congelada no pedido; mudanças posteriores não alteram um Pix emitido.
- Pix desativado por padrão em todas as unidades. Pedidos legados continuam no fluxo a combinar.
- Novos pedidos (`flow_version=2`): cliente escolhe **Pix** (quando habilitado) ou **cartão na maquininha**, entrega/retirada → reserva por 10 minutos → RECEIVED aguardando aprovação da loja.
- Aprovação com Pix: WAITING_PAYMENT → reserva renovada por 15 minutos → QR/Copia e Cola → confirmação bancária → CONFIRMED. Não há cobrança antes da aprovação nem despacho antes do pagamento.
- Aprovação com cartão: CONFIRMED diretamente, com valor **a cobrar presencialmente**. Não coleta dados do cartão, não integra adquirente e não registra pagamento automaticamente.
- Taxa fixa aplica-se também ao cartão, mesmo com Pix desabilitado; retirada não cobra taxa. Valor/método são congelados no checkout.
- CONFIRMED + DELIVERY: worker cria uma entrega AWAITING_COURIER, vinculada por ID único, usando o serviço operacional existente. Loja pode atribuir individualmente ou inserir em rota. Cliente/WhatsApp/endereço e resumo dos itens/preparo são copiados; cobrança na maquininha ou Pix já pago aparecem nas instruções. Resumo operacional limitado a 1.000 caracteres; itens completos permanecem nos pedidos do catálogo.
- CONFIRMED + PICKUP: loja marca READY_PICKUP e depois COMPLETED; nunca cria entrega/rota. Entregas vinculadas são concluídas pela operação, não por um atalho no pedido comercial.
- Cliente não informa valor confiável nem consegue marcar pagamento como recebido. Estoque baixa uma vez na liberação operacional; confirmação e cancelamento congelam/restituem custos sem duplicação.
- Caixa reconhece o recebimento confirmado; DRE gerencial reconhece produtos + taxa na conclusão, sem segunda baixa de caixa.

## Configuração e ordem de implantação

1. Aplicar 0068 com a credencial de migração (0067 já aplicada), antes de publicar API e worker. Não executar rollback removendo tabelas com cobranças reais.
2. Publicar backend e worker da mesma versão, depois frontend. O frontend novo requer as rotas de cotação/pagamento. Worker deve ficar ativo, com execução contínua, inclusive quando não há navegador aberto.
3. Conferir CNPJ no cadastro da **empresa**. Em **Integrações → BTG**, preencher Client ID, Client Secret e chave Pix da conta da empresa; salvar com senha do gestor e autorizar novamente. A alteração da configuração invalida a versão da autorização anterior.
4. `BTG_ENABLED=true`, `BTG_REDIRECT_URI` e `BTG_ENCRYPTION_SECRET` estável na infraestrutura. Credenciais bancárias são por empresa; não há fallback do Client ID/Secret do `.env`.
5. Depois de homologar a autorização, selecionar **produção** no BTG. O checkout real recusa sandbox porque respostas simuladas não podem liberar estoque/pedidos reais. Ambiente bancário não depende de NODE_ENV.
6. Como gestor, acessar **Publicação do catálogo → Pagamento e entrega**, selecionar a unidade, informar taxa (ex.: `7,50`), habilitar Pix e confirmar com senha. A habilitação consulta a API autenticada de locations no CNPJ local; a emissão valida novamente conta, chave, identificadores e valor retornados pelo banco.
7. Fazer homologação controlada com o responsável: entrega e retirada, confirmação, expiração, interrupção de rede, reinício do worker e cancelamento de pedido pago. Testes locais não substituem essa validação. Nenhuma cobrança/autorização real foi feita nesta entrega.

O callback OAuth ainda depende de cookies entre frontend e backend: Safari/bloqueio de cookies de terceiros pode exigir domínios same-site. Não retirar a validação de cookie para contornar esse requisito. Consulte `btg-authorization.md`.

## Operação e recuperação da entrega automática (0068)

- Worker de fulfillment independente do Pix/notificações: tick de 5 segundos, até 30 pedidos por lote, nova consulta da entrega a cada 15 segundos e retry em 30 segundos após falha. São intervalos de consulta, não garantia de latência. Requer worker publicado/ativo.
- Ordem de locks: loja → pedido → leitura da entrega. Criação, histórico operacional, outbox e vínculo comercial são transacionais; crash antes do commit não deixa entrega órfã. Retentativa consulta o vínculo existente, sem criar outra entrega.
- DELIVERED sincroniza COMPLETED e reconhecimento na DRE; CANCELLED sincroniza cancelamento e devolução de estoque uma vez. Falha/retorno da entrega não é tratado como venda concluída. Devoluções que exigem inspeção continuam no fluxo operacional de ocorrências.
- Depois de vinculada, cancelar pela operação de Entregas/Rotas; antes do vínculo ou durante aprovação/Pix, cancelar em Pedidos do catálogo. O pedido comercial bloqueia cancelamento direto de uma entrega vinculada para não deixar rota ativa atendendo pedido cancelado.
- Cartão concluído gera **conta a receber**, não caixa. O gestor deve conferir o comprovante e registrar a baixa no Financeiro. Pix bancário mantém recebimento único; concluir não baixa caixa outra vez.
- Pedidos antigos (`flow_version=1`) preservam o contrato anterior. Nova API exige método explícito e versão da cotação; publicar frontend compatível junto com API/worker e orientar atualização de PWA antigo.
- Validação local em PostgreSQL isolado e mocks do banco/serviço de entrega. Sem migração compartilhada, deploy ou transação BTG real nesta alteração. Homologar com loja e aparelho físico antes de liberar clientes.

## Confirmação, falhas e operação

- A confirmação financeira continua por **consulta autenticada do worker ao BTG**. O webhook implementado em `btg-pix-webhook.md` antecipa essa consulta ao receber `instant-collection.paid`; o corpo da notificação nunca liquida pedidos diretamente. O app consulta apenas o status local a cada 10 segundos; o botão Conferir não cria nova cobrança. API retorna `Cache-Control: no-store` e o service worker Angular não tem cache de dados da API.
- Rotina Pix independente da rotina de notificações, até 3 pedidos concorrentes, consulta normalmente a cada 30 segundos, timeout de 15 segundos por chamada. Expirados com cobrança conhecida são reconsultados a cada 10 minutos durante 7 dias. Dimensionar filas/limites bancários antes de ampliar o volume. Após esse prazo, conciliação operacional no banco é necessária.
- Antes de POSTar uma cobrança, grava REQUESTED. Timeout, resposta inesperada ou encerramento do processo nunca provocam outro POST para o mesmo pedido. A próxima execução pesquisa a cobrança existente pela location/ID e, se necessário, pela referência única no displayText. Resultado ausente ou ambíguo permanece em conferência. Não substitui o QR por outro.
- Confirmação confere empresa/CNPJ, chave, ID, txId, location, valor original fixo, paidAmount, data e endToEndId. EndToEndId único e transação por loja impedem liquidação duplicada. Somente confirmação bancária confiável altera o estado financeiro.
- Expiração libera reserva uma vez. Pagamento observado depois de o pedido já ter expirado **não reativa o pedido**, mesmo se o banco registrar pagamento anterior ao vencimento: fica em conferência para evitar sobrevenda. Divergência de valor também não libera pedido.
- Pagamento tardio, divergente e cancelamento de pedido pago exibem **devolução/conferência pendente**. Não há devolução automática nesta etapa; o gestor precisa conferir/tratar no banco. Uma baixa confirmada pelo BTG não pode ser revertida manualmente como se o dinheiro tivesse voltado. Ainda será necessária uma etapa específica de conciliação das devoluções e encerramento desse marcador.
- Não desabilitar/trocar configuração BTG com cobranças pendentes sem coordenar conciliação: worker exige configuração válida e autorizada. Segredos/tokens são criptografados, não retornados ao cliente, e erros bancários não são copiados para logs.
- Aviso seguro do worker: `commerce worker: Pix reconciliation failed; retry scheduled`. Conferir saúde do worker, configuração, autorização e fila. Um pedido em CREATED sem evolução pode indicar worker desligado ou autorização indisponível.

## Endpoints novos

- Gestor: `GET/POST /commerce/stores/:storeId/payment-settings`, tenant/unidade verificados no servidor, versão otimista e senha atual no POST.
- Cliente autenticado + token do carrinho: `GET /customer/commerce/carts/:id/payment-quote`.
- Checkout existente aceita `paymentVersion`; versão ausente não permite contornar Pix em unidade habilitada. Valores são calculados no banco, nunca aceitos do navegador.
- Cliente dono do pedido: `GET /customer/commerce/orders/:id/payment`, DTO limitado e QR gerado localmente a partir do EMV. Não utiliza serviço externo de QR.

## Referências oficiais

- [Criar cobrança imediata](https://developers.empresas.btgpactual.com/docs/api-specs-target/Banking%20-%20PixCashin/create-instant-collection)
- [Consultar cobranças](https://developers.empresas.btgpactual.com/docs/api-specs-target/Banking%20-%20PixCashin/get-instant-collections)
- [Consultar locations](https://developers.empresas.btgpactual.com/docs/api-specs-target/Banking%20-%20PixCashin/get-locations)
- [Refresh Token](https://developers.empresas.btgpactual.com/es/docs/starting-doc/Integrando/Fluxo%20de%20autoriza%C3%A7%C3%A3o/Refresh%20Token)

Valores da API BTG são reais decimais; armazenamento/cálculo da aplicação usa centavos inteiros. URLs são fixas em código e redirecionamentos HTTP rejeitados.

## Checkout e prazo de aprovação — revisão de 27/10/2026

- Migração 0069 aplicada na base do `.env` em 28/10/2026 01:11:01 UTC; sem publicação ou transação bancária real.
- Leituras de pedidos do cliente incluem `serverTime` obtido do PostgreSQL, mantendo o escopo do cliente autenticado. Contador usa `reservationExpiresAt` e a hora de recebimento local: não reinicia ao abrir o detalhe e não cancela pedidos pelo navegador. Consulta periódica continua após expiração para identificar pagamentos tardios.
- Mantido o contrato da 0068: 10 minutos antes da aprovação, sem cobrança Pix. Recusa/expiração libera a reserva sem gerar cobrança; aprovação inicia prazo separado de 15 minutos para o Pix. Pagamento após cancelamento/vencimento continua em conferência/devolução sem reativar atendimento.
- O cliente vê **Devolução pendente** quando `refundRequired` está marcado. A mensagem informa o dever de restituição conforme a legislação aplicável, sem inventar prazo universal nem afirmar devolução já executada. `REVIEW_REQUIRED` sem pagamento confirmado permanece em conferência.
- **Devolução bancária automática não implementada/habilitada.** O BTG descreve `PIX_REVERSAL` na API de Pagamentos e Transferências usando `originalEndToEndId`; as iniciações dependem de aprovação no internet banking/app e das permissões bancárias da empresa. O escopo Pix Cash-in atual não substitui essa autorização. A loja precisa providenciar e confirmar a devolução pelo banco; não há baixa fictícia nem chamada de transferência nesta revisão.
- Referências: [BTG — Pagamentos e Transferências](https://developers.empresas.btgpactual.com/docs/starting-doc/Produtos%20de%20API/Conta%20PJ/Pagamentos%20e%20Transfer%C3%AAncias/pagamentos) e [CDC, art. 35](https://planalto.gov.br/ccivil_03/leis/l8078compilado.htm). Prazo/comunicação de restituição deve ser validado com o responsável jurídico e o contrato bancário antes de prometer data ao cliente.

## Verificações locais e pendências gerais

Na revisão 0068: **202 testes selecionados de backend** aprovados (9 arquivos), incluindo integração SQL/RLS PGlite, aprovação, recusa, expiração, entrega idempotente, retirada, custo/estoque e caixa sem duplicação, isolamento e regressão BTG/entregas. Build e lint aprovados. Frontend: **31 testes direcionados**, build e integridade de 184 arquivos PWA aprovados; lint dos arquivos alterados aprovado. Lint global do frontend tem erro preexistente em `catalog-import.page.html:21` e build mantém avisos CommonJS IVS.

Prévia local com componentes reais e API simulada: seleção de cartão/Pix, envio fictício e espera de aprovação verificados no navegador; larguras 320, 375, 390, 430, 768, 1024 e 1280 sem overflow horizontal. Console observado sem erros. Não substitui teste com BTG/aparelho físico e banco contratado.

`npm audit --omit=dev` sinalizou 8 dependências de produção (6 high, 2 moderate) já presentes na cadeia do backend, incluindo Zod, Nodemailer, Engine.IO e gRPC. Nenhum alerta apontou o novo gerador QR. A atualização dessas dependências precisa de revisão/regressão antes da ativação produtiva; não foi executado `audit fix --force` nem alteradas versões fora deste escopo.
