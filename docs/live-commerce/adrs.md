# Decisões de arquitetura para vendas por live

Decisões propostas em 21/10/2026 para implementação incremental no RastreiaAPP. Os limites de pacote foram confirmados pelo responsável pelo projeto; preço sugerido e configuração AWS ainda dependem de aprovação e homologação.

## ADR 1 Integração ao produto existente

Manter o backend Fastify e o frontend Ionic/Angular existentes. Criar módulos `commerce/catalog`, `inventory`, `carts`, `orders`, `lives`, `notifications` e `finance`, conforme cada fase. Reutilizar identidade, tenant/loja, Geoapify, auditoria, storage, telemetria e push global.

Pedido comercial é diferente de entrega: criar `commerce_orders`, não adaptar `deliveries` para armazenar itens, pagamentos e receitas. O conector iFood continua independente. A identidade de cliente existente será usada no checkout; assistir e compor carrinho não exigem conta.

RLS comercial deverá exigir tenant e acesso comercial à loja, além de role/capability. Não copiar somente `store_in_scope`, pois o escopo operacional também contempla entregadores e rastreio público. Custos e dados financeiros têm autorização distinta de produtos públicos. Para consumidores, expor somente catálogo publicado e pedidos próprios.

A integração logística usa serviço interno na mesma aplicação, com transação e outbox. Não criar `RASTREIA_API_KEY` nem requisição HTTP para o próprio backend. Caso haja separação futura de serviços, o adaptador terá autenticação de máquina, webhook assinado e idempotência.

## ADR 2 Transmissão por provedor especializado

Provedor inicial proposto: Amazon IVS Low-Latency. Isolar operações em `LiveStreamingProvider`: criar canal, obter sessão autorizada do apresentador, obter playback, interromper stream e consultar saúde. Não colocar vídeo em Socket.IO, Redis ou Cloud Run.

O estúdio web usará Broadcast SDK, e OBS usará RTMPS. O SDK web precisa receber a stream key para iniciar a transmissão; portanto, “não guardar no frontend” significa não persistir em storage, bundles, cache, analytics ou logs. Entregar apenas transitoriamente ao operador autorizado, com `Cache-Control: no-store`; nunca ao espectador. Credenciais IAM permanecem exclusivamente no servidor. Não assumir que uma stream key nativa expira sozinha: rotação/revogação e reconciliação serão explícitas. [Broadcast SDK](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/broadcast-web-getting-started.html), [configuração de transmissão](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/getting-started-set-up-streaming.html).

Usar canal com playback autorizado para o controle de admissão de espectadores anônimos, sem exigir cadastro. Token público da live identifica a sessão comercial; não é stream key nem credencial AWS. Token de playback será curto, restrito à sessão, renovado sob validação de admissão. O número de sockets não equivale a espectadores de vídeo; reconciliar leases, múltiplas abas, métricas do provedor e reconexões. A efetividade do limite de 200 deve ser validada na POC, sem prometer um teto de faturamento apenas com contador local.

O player terá carregamento sob demanda, detecção de suporte, interação para áudio e `playsinline`. Assets de worker e WASM precisam publicação e Content-Type corretos, especialmente com o rewrite SPA do Firebase. [Player SDK](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/web-getting-started.html).

Não registrar um segundo service worker no mesmo escopo do Angular sem validar compatibilidade. Não garantir câmera/transmissão PWA em segundo plano; testar minimização, bloqueio de tela e retorno. Uma interrupção do vídeo não encerra automaticamente a sessão comercial.

## ADR 3 Consistência comercial

Live, carrinho, pedido, pagamento e entrega possuem ciclos independentes. Encerrar live ou vencer adicional não executa cascata de exclusão nem cancela vendas. Carrinhos continuam acessíveis; preços/estoque são revalidados no checkout. Uma oferta com validade própria pode expirar, mas isso precisa ser explícito, não consequência oculta do fim do vídeo.

PostgreSQL é fonte de verdade; IndexedDB é espelho recuperável. Carrinho de visitante usa token aleatório cujo hash fica no servidor, TTL inicialmente proposto de 30 dias e isolamento por loja. A escolha de armazenamento da credencial no navegador deve passar pelos testes de persistência/cookies entre Firebase e Cloud Run; não depender de cookie de terceiros no iOS. Preferir sessão HttpOnly em origem própria quando viável. Nenhum token vai em URL/logs; dados sensíveis não são sincronizados em caches públicos.

Merge no login exige posse do carrinho e identidade autenticada, locks em ordem consistente e chave idempotente. Mudanças offline são intenções a reconciliar, não confirmação de estoque, preço ou pagamento.

Valores monetários trafegam como centavos inteiros ou strings decimais validadas, sem arredondamento binário em cálculos financeiros. Itens do pedido congelam descrição/SKU, preço, desconto, custo e taxas. DRE histórica não consulta custo atual do produto.

Reservar estoque somente no checkout, com prazo proposto de 10 minutos. Bloquear linhas em ordem de variante, checar saldo menos reservas, gravar pedido/reserva/outbox na mesma transação. Expiração, conversão e cancelamento precisam disputar o mesmo lock; confirmação tardia de pagamento exige reconciliação ou estorno, não estoque negativo. Renovação não pode ser ilimitada.

Chamadas a provedores ficam fora das transações longas. Persistir intenção antes da chamada, usar chave idempotente e reconciliar retorno incerto. Webhooks são autenticados e gravados antes do processamento. Sem provedor escolhido, pagamento online não será apresentado como funcional.

## ADR 4 Adicional contratado por unidade

Pacotes versionados, com preço BRL, quantidade mensal, duração máxima, audiência simultânea, qualidade e vigência. A contratação guarda snapshot da versão/preço; alterar o catálogo de planos não altera contratos anteriores nem faturas emitidas. O master administra; gestor consulta/solicita e não concede direito a si mesmo.

Pacote de referência: **Live 4**, quatro lives mensais de até 120 minutos, até 200 espectadores simultâneos. Proposta inicial: uma transmissão simultânea por unidade, qualidade máxima HD 720p e sem gravação. Demais limites podem variar por pacote. HD, ausência de gravação e preço são propostas, não decisões já ativadas.

### Estimativa inicial e preço sugerido

No cenário de todos os 200 espectadores assistindo às quatro lives inteiras, são 1.600 horas de audiência e 8 horas de entrada. Usando canal Standard e saída HD na América do Sul, a tabela consultada indica US$ 2/h de entrada e US$ 0,084/h de saída na primeira faixa: **US$ 150,40/mês somente de vídeo**. [Preços Amazon IVS](https://aws.amazon.com/ivs/pricing/).

Sugestão comercial inicial: **R$ 1.490/mês por unidade**, editável e ainda não aplicada. Com câmbio hipotético de planejamento de R$ 6/US$ (não cotação), o vídeo seria R$ 902,40. A diferença deve cobrir impostos, infraestrutura, suporte, meios de pagamento e margem; validar esses itens antes de comercializar. Excedentes e gravações não estão incluídos. Não é garantia de custo máximo nem inclui variação cambial.

### Medição e bloqueios

- Proposta de competência: mês civil no timezone contratual da unidade; limites inicial/final persistidos em UTC. Sem acumular saldo. Regra de adesão no meio do mês e prorrata precisa ser confirmada antes da primeira cobrança.
- Ao solicitar início, bloquear assinatura/período e reservar uma unidade da cota; duas requisições simultâneas não podem gastar a mesma vaga. Chave única por live impede nova contagem em retry/reconexão.
- Confirmar consumo após evidência de início pelo provedor. Falha comprovada antes de transmissão libera reserva. Estado incerto aguarda reconciliação para não permitir lives gratuitas por timeout.
- Cancelar agendamento antes da transmissão não consome. Live efetivamente iniciada conta uma vez, inclusive se encerrada antes de 120 minutos. Ajuste de consumo somente pelo master, com motivo e auditoria.
- Reconexão não reinicia o relógio nem cria outra cota. A 5ª live do pacote mensal é recusada; ajuste de pacote no período considera o consumo já realizado.
- Worker verifica prazo máximo e interrompe transmissão ao completar 120 minutos, revogando/rotacionando a credencial para impedir reinício pelo encoder. Não depender do timer do navegador. Alertar antes do encerramento e reconciliar falhas do provedor.
- Expiração/cancelamento do adicional impede novos inícios. Regra proposta: live já autorizada termina até seu limite original; cancelamento por segurança permite interrupção imediata auditada.
- Falha/inadimplência do adicional não suspende o acesso a carrinhos, pedidos, histórico ou entregas. O módulo de billing atual precisa distinguir a cobrança do adicional dos bloqueios gerais da unidade.
- Contratação não significa cobrança automática: inicialmente ativação master auditada e cobrança pelo fluxo existente adaptado. Gateway/recorrência automáticos são uma decisão separada.

## ADR 5 Eventos e notificações

Evoluir a outbox existente, sem introduzir BullMQ apenas por sugestão do escopo. Antes do primeiro evento comercial, publicar worker com dispatch explícito, rejeição/retentativa de tipo desconhecido e resultado por consumidor. Retirar todas as revisões antigas que fazem claim irrestrito. Manter a funcionalidade de emissão comercial desligada até essa verificação.

Quando um evento alimenta despacho, caixa interna, Socket.IO e push, cada destino precisa de confirmação e deduplicação próprias. Falha no push não deve repetir criação de entrega. Não marcar o evento completo enquanto consumidores obrigatórios estiverem pendentes.

Eventos terão ID, sequência/versão do agregado e `effectiveAt`; reconnect consulta snapshot e cursor, não assume entrega confiável de todos os sockets. Dois operadores alterando produto atual disputam versão no banco. Interação de vídeo e banner exige teste de latência percebida, pois socket pode chegar antes do quadro correspondente.

Notificações internas persistem por destinatário e têm lido/não lido. Push global reaproveita VAPID; usar notificationId para deduplicar. Revalidar escopo no envio e na leitura. Cliente recebe só seus pedidos; entregador recebe só sua logística; gestores recebem lojas autorizadas. Não usar telefone isolado como comprovação de identidade.

## Prova de conceito necessária

Estado: **não executada**; falta conta AWS e autorização do orçamento de teste. Preparação documental não comprova transmissão funcional.

1. Criar ambiente de teste isolado, configurar identidade AWS de privilégio mínimo e limites/alertas de custo. Não reutilizar automaticamente credenciais S3. Estabelecer custo autorizado antes de abrir canal.
2. Publicar estúdio mínimo HTTPS em homologação: solicitar câmera/microfone, preview, iniciar/parar e alternar câmera. Conferir que credenciais não persistem em storage, logs, respostas públicas ou cache.
3. Testar Chrome Android, Safari iPhone e PWA instalada; medir tempo de início, áudio, orientação, aquecimento, consumo, conexão 3G/4G e retorno após suspensão. Comparar com OBS/RTMPS como contingência.
4. Testar player com admissão anônima, convite inválido, expiração/renovação de token, 200 admissões e recusa da 201ª, abas extras e leases abandonados. Confirmar custos/métricas no provedor.
5. Testar término pelo servidor aos 120 minutos e tentativa do encoder de reconectar. Falha deve gerar alerta e reconciliação, sem depender do cliente aberto.
6. Validar interrupção/reconexão, produto atual com sequência, tentativa dupla de início e preservação de carrinho/pedido após encerrar.
7. Registrar dispositivos/versões, latência p50/p95, falhas, horas consumidas e resultado. Teste de 200 espectadores reais gera custo: executar só após orçamento autorizado. Não confundir 200 sockets simulados com 200 players de vídeo.

Para AWS, acrescentar configurações de streaming de forma desabilitada por padrão quando a integração for implementada, preservando nomes JWT, Redis, VAPID e storage existentes. Nunca versionar valores reais. Região, tipo de canal, credenciais de controle e assinatura de playback serão configurados antes da POC, sem exibi-los no chat.
