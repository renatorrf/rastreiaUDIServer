# Sessões comerciais de live — implementação local

24/10/2026. Migração **0061 preparada, não aplicada na base compartilhada**. Sem deploy, AWS, mudança de credenciais ou cobrança.

## Fluxo e regras

1. Master vincula um pacote vigente à unidade usando a administração já existente.
2. Gestor entra em **Vendas → Lives**, cria título, horário previsto opcional e lista ordenada de até 100 produtos. Horário não dispara início automático.
3. Para ativar, catálogo/unidade precisam estar públicos/ativos; todos os produtos precisam ser ativos, publicados e possuir variante ativa. Produto sem saldo pode ser apresentado, mas permanece indisponível para compra conforme o catálogo; sob encomenda mantém sua regra existente.
4. Início exige confirmação explícita, consome **uma sessão comercial** do mês e destaca o primeiro produto. A interface alerta que vídeo ainda não está habilitado. Não executar testes de ativação em unidades comerciais reais sem combinar o consumo da cota.
5. Loja usa **Destacar**, **Anterior**, **Próximo** ou **Ocultar destaque**. Anterior/próximo pulam produtos despublicados/inativados. O conjunto/ordem dos produtos só pode ser editado antes do início.
6. Encerramento é definitivo, não devolve cota e preserva carrinhos/pedidos. Cancelar uma sessão preparada não consome cota. Não há exclusão física.

Estados: `WAITING → LIVE → ENDED`, ou `WAITING → ENDED`. Versão aumenta a cada alteração efetiva. Uma unidade pode manter somente uma sessão em andamento. A quantidade mensal é somada por unidade, não por contrato, no mês civil em `America/Sao_Paulo`; trocar contrato não zera o uso. Sessões preparadas não entram no consumo.

O prazo máximo é o menor entre duração contratada e fim da vigência. Consulta pública bloqueia atividade comercial imediatamente ao vencer prazo/contrato; manutenção do worker e consultas administrativas materializam o encerramento. Não depende de cronômetro do navegador. Ainda não há transmissão a interromper no provedor.

## API implementada

Todas as rotas administrativas são `/commerce/stores/:storeId/lives`, somente `TENANT_MANAGER`, usando a empresa/lojas da sessão autenticada. `GET` coleção aceita `status=ACTIVE|ALL`, `limit` até 50 e `offset`. Retorna `{data,total,entitlement}`. `GET /:id` inclui `items` com elegibilidade atual.

`POST` cria; `PATCH /:id` edita. Corpo: `{title,scheduledAt:null|ISO,productIds:uuid[]}`, e `expectedVersion` obrigatório no PATCH. IDs duplicados e campos extras são rejeitados.

`POST /:id/start` e `/end`: `{expectedVersion}`. `POST /:id/current-product`: `{expectedVersion,action:'SELECT'|'NEXT'|'PREVIOUS'|'HIDE',productId?}`; `productId` somente para SELECT.

Escritas exigem `Idempotency-Key`. Mesmo ator, operação, chave e payload recuperam a resposta anterior. Acesso à unidade/sessão é revalidado **antes** do replay. Front mantém a mesma chave/payload após resultado incerto e bloqueia ações concorrentes. Conflitos de versão exigem atualização; não sobrescrevem outro gestor.

Público: `GET /public/lives/:publicToken`, 64 caracteres hexadecimais aleatórios, `Cache-Control: no-store`, projeção restrita com estado, sequência, loja e produto público. Não expõe playlist administrativa, custo, tenant, assinatura, chaves ou dados de compradores. Catálogo não publicado retorna 404. Produto despublicado deixa de aparecer no destaque. Estoque/preço são revalidados pelo carrinho/checkout existente, não pelo snapshot da live.

## Segurança e persistência

- Tabelas `commerce_live_sessions`/`commerce_live_items` com FORCE RLS e FKs compostas por empresa/unidade, incluindo contrato e produto.
- Inícios serializados por lock da unidade, contrato bloqueado contra cancelamento concorrente e índice único para sessão ativa. Replays não consomem novamente.
- Função restrita `commerce_lock_live_subscription` permite ao gestor bloquear seu contrato vigente, mas não editar termos. Projeções públicas SECURITY DEFINER seguem o padrão existente, com search_path fixo e grants explícitos.
- Auditoria de criação, edição, início, destaque e encerramento manual; expiração automática registra razão/data/versão na sessão. Sem uso do outbox logístico para eventos comerciais.
- Worker isolado por try/catch; falha de manutenção de live não impede iFood/notificações existentes.

## Ativação e limites

Aplicar a migração 0061 pelo runner existente **somente após autorização**, antes de atualizar API/worker e frontend. Nenhuma nova variável `.env` é necessária nesta etapa. A migração não cria sessões, contratos, usuários ou dados de demonstração.

Para homologar: contratar pacote em unidade de teste, publicar catálogo/produtos, criar/ordenar sessão, abrir link público, ativar, alternar/ocultar destaque, comprar pelo modal compartilhado, encerrar e conferir histórico/cota. Testar gestor de outra unidade e entregador sem acesso.

Pendente: AWS IVS, estúdio, credenciais de transmissão, admissão/limite real de espectadores, eventos em tempo real e dimensionamento de polling. Não se deve vender esta etapa como transmissão de vídeo pronta. O limite de audiência do plano é apenas configuração para a etapa de vídeo.

## Validação local

- Build e lint do backend aprovados; 129 testes do módulo commerce aprovados.
- Integração PostgreSQL isolada via PGlite aplica 0061 e verifica RLS, FKs, publicação, cota, idempotência, duração, expiração/cancelamento, mudança de mês, ordenação e preservação do carrinho.
- Testes HTTP de autenticação, papéis, escopo antes do replay, validação e projeção pública.
- Não testado contra PostgreSQL contratado, Cloud Run, carga de 200 espectadores ou concorrência real entre conexões PostgreSQL; proteções de concorrência implementadas via locks/constraints, sem alegar benchmark.
