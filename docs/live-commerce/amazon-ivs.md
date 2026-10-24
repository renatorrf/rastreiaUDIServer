# Amazon IVS e estúdio da loja

Implementação local de 24/10/2026. A AWS ainda será configurada pelo responsável. **Nada foi provisionado ou publicado. A migração 0062 foi preparada e testada isoladamente, não aplicada ao banco compartilhado.** A 0061 já havia sido aplicada.

## O que está disponível no código

- Vendas → Lives → Gerenciar → Abrir estúdio de vídeo. Prévia local, permissão explícita de câmera/microfone, confirmação de início, áudio, desligar câmera, reconectar, encerrar e destacar produtos.
- Início comercial existente, com idempotência, controle de versão, assinatura vigente e cota mensal. Consumir uma sessão inicia o relógio mesmo se o vídeo não conectar; a confirmação explica isso. Reconectar a mesma sessão não consome outra cota nem reinicia sua duração.
- Amazon IVS **Low-Latency**, não IVS Real-Time Stages. Canais privados dedicados a cada unidade, provisionados previamente pela plataforma. A aplicação não cria canais, contas, planos AWS, gravações nem cobranças.
- SDK Web Broadcast carregado sob demanda. Captura inicial em 480p/30 fps, até 1,5 Mbps; áudio e vídeo somente após ação e permissão. Manter estúdio em primeiro plano; Android/iOS, interrupções por chamadas e desempenho precisam de homologação física.
- Player público independente do produto em destaque e do modal Comprar este. Seleção de tamanho/cor/quantidade e carrinho existentes permanecem intactos. O vídeo começa por ação do cliente, inicialmente sem som, com controles para ativá-lo.
- Um estúdio por sessão: posse aleatória de 256 bits apenas em memória, hash no banco, vínculo com gestor e unidade; heartbeat a cada 20 s, lease de até 90 s. Abandono, fim do pacote, catálogo despublicado, término ou prazo acionam limpeza.
- Chave de ingestão é buscada/criada no backend e entregue apenas ao estúdio autorizado. Não é armazenada em respostas de idempotência, banco, auditoria ou armazenamento do browser. Recuperação de CreateStreamKey incerto usa o identificador da live na tag. Chaves externas/manuais não são apagadas automaticamente.
- Espectadores recebem JWT ES384 de uso único, viewer-id anônimo e origens HTTPS restritas. O JWT dura até 120 s para iniciar reprodução; **expiração do JWT não encerra vídeo já aberto**. A aplicação mantém lease, revoga sessões e interrompe a transmissão no provedor.
- Admissão serializada no banco pelo limite do plano, renovação sem nova vaga, liberação ao sair e revogação pelo worker. Vagas permanecem reservadas por mais 60 s após a solicitação de revogação. Essa janela é uma decisão conservadora da aplicação, **não uma garantia de propagação da AWS nem um teto financeiro**. Validar concorrência real e propagação antes de prometer um limite instantâneo de audiência.

## Ativação, depois de configurar a AWS

1. Aplicar **0062_commerce_live_video.sql**, com autorização para o banco correto. Implantar backend, frontend e worker compatíveis. O modo desligado não consulta as novas tabelas durante a navegação normal.
2. Escolher uma região IVS disponível na conta. O padrão de configuração é `us-east-1`, mas não representa uma decisão de contratação. Cada ARN deve usar a mesma região configurada.
3. Criar um canal **exclusivo por unidade**, com autorização de playback ligada, latência LOW e ingestão segura. Escolher BASIC/STANDARD conforme qualidade/custo aprovados; o estúdio desta etapa envia 480p. Não compartilhar o canal com OBS, testes externos ou outra unidade.
4. A criação de canal gera uma chave inicial. Antes de liberar a aplicação, verificar que não existe transmissão e remover **somente essa chave inicial**, pelo ARN conferido, via API/CLI AWS. O sistema criará sua própria chave identificada por live. Um simples reset gera outra chave e não resolve esse pré-requisito. Não executar exclusões em canais de terceiros.
5. Criar/importar um par de chaves de autorização de playback ES384. Guardar a privada PEM PKCS#8 no Secret Manager; a pública fica na AWS. Não é a stream key nem uma chave de acesso IAM.
6. Configurar credenciais AWS no backend e no worker pela cadeia padrão do SDK: preferir role/federação. Se forem usadas chaves IAM, armazenar `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` e, quando temporário, `AWS_SESSION_TOKEN` em segredo. Não reutilizar variáveis S3 nem inserir credenciais no frontend/Git.
7. Permissões IAM necessárias ao runtime: `ivs:GetChannel`, `ivs:GetStream`, `ivs:ListStreamKeys`, `ivs:GetStreamKey`, `ivs:CreateStreamKey`, `ivs:TagResource`, `ivs:DeleteStreamKey`, `ivs:StopStream`, `ivs:StartViewerSessionRevocation`. Restringir aos canais dedicados e respectivas chaves gerenciadas, com condições de tags quando aplicável. Revisar os tipos de recurso/dependências na referência oficial, sem conceder `ivs:*` ou permissões administrativas gerais. Provisionamento de canal/par de playback é separado do runtime.
8. Configurar API e worker, sem exibir os valores secretos:

| Variável | Finalidade |
| --- | --- |
| `IVS_ENABLED` | `false` até terminar a preparação; `true` para habilitar |
| `IVS_REGION` | Região dos canais e das chamadas AWS |
| `IVS_CHANNELS_JSON` | Objeto JSON: UUID real da unidade → ARN de seu canal exclusivo; nenhum segredo |
| `IVS_PLAYBACK_PRIVATE_KEY` | Privada ES384 em PEM; aceita novas linhas reais ou `\n` |
| `IVS_PLAYBACK_ORIGINS` | De 1 a 5 origens HTTPS exatas, separadas por vírgula; por exemplo os hostnames Firebase realmente utilizados |

Não copiar os valores de exemplo como credenciais. A configuração de integração global não substitui as regras de pacote por unidade. A variável de origens é separada de `APP_ORIGINS` para não enviar origens Capacitor/HTTP à autorização de vídeo. Se omitida, usa `APP_ORIGINS` somente se todas forem HTTPS e houver no máximo cinco.

9. Manter o worker em execução contínua, com CPU e instância disponíveis, não dependente de requisições web. API/worker devem compartilhar banco e configuração. O backend bloqueia novas credenciais e renovações se o heartbeat do monitor estiver atrasado mais de 60 s. Falhas de limpeza são repetidas; uma unidade com erro não impede as tentativas das outras.
10. Configurar alertas para indisponibilidade do worker, falhas IAM/StopStream, duração anormal e orçamento AWS. **Se todo o backend/worker cair ou a AWS ficar inacessível, o código não garante corte imediato de ingestão.** Para liberação comercial, testar uma proteção operacional independente no lado AWS e um procedimento de desligamento do canal. Não tratar Budgets/alarme ou cota comercial como corte automático de custos.
11. Fazer uma live curta de homologação em HTTPS com uma unidade de teste e um segundo dispositivo; confirmar visualmente áudio/vídeo, pacote/cota, fim e revogação. Sem conta/canais, estes passos continuam pendentes.

## Rotas e manutenção

- `GET /commerce/stores/:storeId/lives/:id/studio`: configuração disponível, sessão e estado seguro de vídeo; nunca chave.
- `POST .../studio/connect`: `{leaseToken}`; requer sessão comercial LIVE, gestor da unidade e worker saudável. Retorna streamKey somente nessa resposta `no-store`.
- `POST .../studio/heartbeat`: `{leaseToken}`; confirma estado no IVS e renova posse sem alterar cota.
- `POST .../studio/disconnect`: `{}`; registra pedido durável de parada. Não encerra a sessão comercial. Outro gestor autorizado da mesma unidade pode solicitar desligamento.
- `POST /public/lives/:publicToken/video/join|renew|leave`: `{leaseToken}`. Join retorna URL assinada, renew renova posse, leave antecipa revogação. Nenhuma dessas respostas usa cache de idempotência.
- O encerramento comercial existente continua sendo `/end`. O worker remove a chave antes de StopStream, para impedir reconexão com a credencial anterior.
- Tabelas: `commerce_live_video` com FORCE RLS por gestor/unidade; `commerce_live_viewers` sem acesso direto do runtime, apenas funções públicas estreitas; `commerce_live_video_worker` para prontidão. Não alterar vínculos de usuários, entregadores, pedidos ou estoque.

## Testes e limites desta entrega

Validação local cobre SQL/RLS em PGlite, leases, recuperação de falha AWS, limpeza, cota, playback assinado, ausência de segredos persistidos, fronteiras HTTP, estúdio e player com SDK simulado. A migração mantém sintaxe compatível com PostgreSQL 9.6, mas não foi executada no servidor contratado nesta etapa. Testes isolados não substituem concorrência multi-instância no PostgreSQL real.

Não foram testados transmissão real, IAM real, cobrança, 200 espectadores, câmera/microfone reais, dispositivos físicos, latência sob 3G nem revogação real do IVS. Não houve acesso à conta AWS, mudança de `.env` real, migração compartilhada ou publicação. Próxima etapa operacional: aplicar 0062 e preparar a conta/canal, mantendo IVS desabilitado até a homologação.

## Referências consultadas

- [Broadcast SDK Web](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/broadcast-web-getting-started.html)
- [Canais privados](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/private-channels.html)
- [JWT de playback](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/private-channels-generate-tokens.html)
- [Revogação de espectadores](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/private-channels-start-session-revocation.html)
- [Limite de uma stream key por canal](https://docs.aws.amazon.com/ivs/latest/LowLatencyAPIReference/API_CreateStreamKey.html)
- [Ações e recursos IAM](https://docs.aws.amazon.com/service-authorization/latest/reference/list_interactive-video-service.html)
