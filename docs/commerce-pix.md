# Checkout Pix BTG e taxa fixa por unidade

## Entrega desta etapa

- Migração **0067_commerce_pix_checkout.sql**, preparada e testada em PostgreSQL isolado. Não aplicada ao banco compartilhado nesta etapa.
- Taxa de entrega em centavos por unidade. Retirada custa zero. A taxa é congelada no pedido; mudanças posteriores não alteram um Pix emitido.
- Pix desativado por padrão em todas as unidades. Pedidos legados continuam no fluxo a combinar.
- Pix ativo: carrinho → reserva de estoque por 15 minutos → WAITING_PAYMENT → QR/Copia e Cola → confirmação bancária → RECEIVED na fila operacional → confirmação/conclusão da loja.
- A loja não consegue aceitar um pedido Pix sem pagamento. Cliente não informa valor confiável nem consegue marcar o pagamento como recebido.
- Caixa reconhece o recebimento confirmado; DRE gerencial reconhece produtos + taxa na conclusão, sem segunda baixa de caixa.

## Configuração e ordem de implantação

1. Aplicar 0067 com a credencial de migração, antes de publicar API e worker. Não executar rollback removendo tabelas com cobranças reais.
2. Publicar backend e worker da mesma versão, depois frontend. O frontend novo requer as rotas de cotação/pagamento. Worker deve ficar ativo, com execução contínua, inclusive quando não há navegador aberto.
3. Conferir CNPJ no cadastro da **empresa**. Em **Integrações → BTG**, preencher Client ID, Client Secret e chave Pix da conta da empresa; salvar com senha do gestor e autorizar novamente. A alteração da configuração invalida a versão da autorização anterior.
4. `BTG_ENABLED=true`, `BTG_REDIRECT_URI` e `BTG_ENCRYPTION_SECRET` estável na infraestrutura. Credenciais bancárias são por empresa; não há fallback do Client ID/Secret do `.env`.
5. Depois de homologar a autorização, selecionar **produção** no BTG. O checkout real recusa sandbox porque respostas simuladas não podem liberar estoque/pedidos reais. Ambiente bancário não depende de NODE_ENV.
6. Como gestor, acessar **Publicação do catálogo → Pagamento e entrega**, selecionar a unidade, informar taxa (ex.: `7,50`), habilitar Pix e confirmar com senha. A habilitação consulta a API autenticada de locations no CNPJ local; a emissão valida novamente conta, chave, identificadores e valor retornados pelo banco.
7. Fazer homologação controlada com o responsável: entrega e retirada, confirmação, expiração, interrupção de rede, reinício do worker e cancelamento de pedido pago. Testes locais não substituem essa validação. Nenhuma cobrança/autorização real foi feita nesta entrega.

O callback OAuth ainda depende de cookies entre frontend e backend: Safari/bloqueio de cookies de terceiros pode exigir domínios same-site. Não retirar a validação de cookie para contornar esse requisito. Consulte `btg-authorization.md`.

## Confirmação, falhas e operação

- Nesta versão a confirmação é por **consulta autenticada do worker ao BTG**, não webhook público. O app consulta apenas o status local a cada 10 segundos; o botão Conferir não cria nova cobrança. API retorna `Cache-Control: no-store` e o service worker Angular não tem cache de dados da API.
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

## Verificações locais e pendências gerais

169 testes selecionados de backend aprovados, incluindo integração SQL/RLS PGlite, orquestração de cobrança com persistência/banco simulados, isolamento de empresas e regressão BTG. Build e lint aprovados. Frontend: 34 testes direcionados e build/PWA; lint dos arquivos alterados aprovado. Lint global do frontend tem erro preexistente em `catalog-import.page.html:21` e build mantém avisos CommonJS IVS.

`npm audit --omit=dev` sinalizou 8 dependências de produção (6 high, 2 moderate) já presentes na cadeia do backend, incluindo Zod, Nodemailer, Engine.IO e gRPC. Nenhum alerta apontou o novo gerador QR. A atualização dessas dependências precisa de revisão/regressão antes da ativação produtiva; não foi executado `audit fix --force` nem alteradas versões fora deste escopo.
