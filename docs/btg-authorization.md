# Autorização BTG — Pix Cobrança

URI a cadastrar exatamente (sem barra final):

`https://rastreiaudiserver-401137614457.southamerica-east1.run.app/integrations/btg/callback`

Esta é uma rota **do backend**, não do Firebase, e não é o webhook de confirmação de pagamentos.
O código local não torna a URI operacional até publicar o backend no Cloud Run.

## Configuração e ativação

1. As migrações `0065_btg_authorization.sql` e `0066_btg_company_settings.sql` foram aplicadas em etapas anteriores. Para o novo checkout Pix, aplicar também `0067_commerce_pix_checkout.sql`, ainda pendente; consulte [Checkout Pix](commerce-pix.md).
2. Cadastrar uma aplicação **confidencial** no ambiente BTG desejado; para operar empresas distintas, conferir o modelo Third-party e a homologação no BTG.
3. No servidor, configurar apenas `BTG_REDIRECT_URI`, `BTG_ENCRYPTION_SECRET` (chave exclusiva e estável de pelo menos 32 caracteres) e a chave geral de habilitação. Guardar a chave criptográfica no Secret Manager, não no frontend, Git, chat ou links. Não rotacionar sem recriptografar credenciais e tokens existentes.
4. Publicar o backend e habilitar `BTG_ENABLED=true` apenas após configurar. O padrão é desativado. O ambiente BTG é independente de `NODE_ENV`.
5. Como gestor, acessar **Integrações → BTG**, selecionar a empresa, informar ambiente (começar por sandbox), Client ID e Client Secret da aplicação dessa empresa e confirmar com a senha atual do gestor. Salvar. As credenciais são criptografadas em `company_service_settings`; consultas retornam apenas a indicação de segredo cadastrado. As variáveis legadas `BTG_MODE`, `BTG_CLIENT_ID` e `BTG_CLIENT_SECRET` não são usadas como fallback. Nenhuma credencial do `.env` é copiada automaticamente para uma empresa.
6. Informar novamente a senha do gestor e clicar **Autorizar no BTG**. Conferir o retorno real, inclusive eco do `state` e parâmetro `iss`. Em produção há exigências de homologação e perfil bancário próprias do BTG.

O callback é o mesmo para todas as empresas, mas credenciais, ambiente, autorização e tokens pertencem à empresa validada no servidor. Cada salvamento incrementa a versão da configuração; estados antigos são rejeitados antes da troca e da gravação dos tokens. Alterar Client ID/ambiente exige novo segredo. Desabilitar a configuração impede novas autorizações. Tokens anteriores não são revogados no provedor automaticamente e não podem ser usados por uma futura rotina de cobranças sem conferir `settings_version`, configuração habilitada e validação da conta.

Esta revisão altera o BTG. Os mecanismos legados de fallback de WhatsApp/iFood permanecem inalterados; não representa remoção geral de todos os parâmetros de integração do `.env`.

## Contrato da ação “Autorizar no BTG”

`POST /companies/:id/integrations/btg/authorization`, Bearer de gestor e JSON `{"confirmationPassword":"senha atual do gestor"}`.

O ID selecionado é validado no servidor contra tenant, perfil, vínculo às unidades e situação atual. Não se aceita tenant, URI de retorno, escopos ou endpoints enviados pelo cliente. A resposta contém `authorizationUrl` e `expiresAt`; navegar na janela principal para essa URL. Não compartilhar/copiar em logs: contém estado temporário. Não abrir em iframe nem fazer fetch da URL de navegação.

O POST autenticado grava o vínculo ao navegador em cookie Secure/HttpOnly/SameSite=None. A chamada do frontend precisa usar `credentials: include`/`withCredentials: true`. **Navegadores que bloqueiam cookies de terceiros entre Firebase e Cloud Run precisam de frontend e API em domínios same-site (ex.: app.empresa.com e api.empresa.com) ou de uma arquitetura de sessão same-origin antes de usar este fluxo.** Não remover a verificação de cookie para contornar esse bloqueio: ela impede callback iniciado em outro navegador. Não existe rota pública que estabeleça o cookie somente por receber um link compartilhado. Uma nova tentativa substitui a anterior da mesma empresa/ambiente; o cookie suporta um fluxo ativo por navegador.

`GET /integrations/btg/callback` valida estado autenticado/criptografado, validade de 10 minutos, issuer, cookie e permissões atuais. O estado é consumido atomicamente no PostgreSQL antes da troca do código, impedindo replay entre réplicas. Timeout de 15 segundos/recusa/falha exigem iniciar nova autorização. Não repetir automaticamente a troca de código.

Troca: POST form-urlencoded ao `/oauth2/token`, autenticação Basic confidencial, URI idêntica à cadastrada e escopos `openid empresas.btgpactual.com/pix-cash-in`. Redirecionamentos HTTP do endpoint de tokens são rejeitados. Não se solicita acesso genérico a saldos/extratos, transferências ou Pix Automático.

Tokens recebidos ficam criptografados (AES-GCM) em `btg_authorizations`, separados por tenant/empresa/ambiente, com RLS de gestor. Não são retornados ao frontend. Auditoria registra apenas empresa, ambiente e status. Resposta HTML estática com CSP, no-store, no-referrer e sem recursos externos; erros do provedor não são refletidos na página.

## Limites da etapa original de autorização

Nota de evolução: a integração de emissão/consulta, renovação de tokens e conciliação foi adicionada posteriormente em [Checkout Pix](commerce-pix.md). Os itens abaixo descrevem a entrega original de autorização, não o novo fluxo. O status histórico PENDING_ACCOUNT_VALIDATION é preservado; a nova rotina valida acesso autenticado ao CNPJ antes de habilitar/emitir cobranças e confere os dados da resposta bancária.

- O status é **PENDING_ACCOUNT_VALIDATION**: a autorização recebida não comprova que o CNPJ/conta escolhido no BTG corresponde à empresa local. Antes de movimentar cobranças, implementar e homologar essa verificação contra dados autenticados do provedor. Não decodificar um JWT sem verificar sua autenticidade para ativar uma conta.
- Tela de configuração e botão de autorização disponíveis em Integrações → BTG. Não foram implementados emissão de cobranças, webhook Pix, renovação/revogação de tokens ou conciliação de pedidos. Não há chamada financeira nesta etapa.
- Nenhuma empresa foi configurada, a migração 0066 não foi aplicada ao banco contratado e não houve publicação nesta revisão. As credenciais locais previamente preenchidas no `.env` foram preservadas, mas não são utilizadas para autorizar empresas.
- Os logs da aplicação omitem a query das rotas BTG. **Cloud Run/load balancer podem registrar URLs completas por conta própria**: configurar exclusão/redação dos logs HTTP destas rotas no pipeline de observabilidade, limitar acesso e retenção antes de autorizações reais; não exportar `code`, `state`, `ticket` nem cookies para analytics/APM. O backend não consegue redigir logs gerados fora dele.
- Sessões expiradas são rejeitadas e substituídas no próximo início; definir retenção/limpeza operacional e política de revogação antes da operação financeira.

## Validação local — 27/10/2026

Build TypeScript e lint dos arquivos alterados aprovados. 59 testes selecionados aprovados (22 BTG, mais regressões de configuração, comunicações e iFood). A migração 0066 foi executada somente em PostgreSQL isolado PGlite, com checagem de RLS entre tenants/unidades, perfil, consumo único, expiração, criptografia, credenciais independentes e rejeição de callback após troca de configuração. Inclui GET/PUT de configuração via HTTP autenticado sem exposição dos segredos. Não foi usado o banco contratado nem houve autorização real no BTG nesta revisão. Os testes HTTP usam retorno simulado do provedor; homologação real e verificação dos cookies no navegador permanecem pendentes.

## Diagnóstico seguro do callback (28/10/2026)

Filtrar os logs da API por `jsonPayload.msg="BTG authorization not completed"`.
O campo `stage` identifica a etapa (`configuration`, `state`, `browser`, `company`,
`issuer`, `consume`, `provider_response`, `exchange` ou `save`). Em `exchange`,
o diagnóstico diferencia:

- `HTTP_REJECTED`: status HTTP e código OAuth de uma lista fechada; valores desconhecidos viram `unrecognized`.
- `TIMEOUT` / `NETWORK_ERROR`: interrupção de transporte, sem texto da exceção.
- `INVALID_JSON` / `INVALID_TOKEN_RESPONSE`: resposta incompatível; apenas nomes de campos conhecidos, nunca os valores.
- `MISSING_SCOPES`: identifica somente `openid` e/ou `pix_cash_in` ausentes na resposta, mantendo a validação vigente.

Nunca registrar corpo do provedor, `error_description`, URL do callback, código,
state, cookies, credenciais ou tokens. A página pública continua genérica. O diagnóstico
não realiza nova tentativa automática, não amplia escopos e não altera consentimentos.
Após falha na troca, iniciar uma nova autorização no portal do gestor. Não reutilizar
o callback consumido. Confirmar a causa com o novo diagnóstico antes de alterar credenciais.

## Referências oficiais

- [Authorization Code](https://developers.empresas.btgpactual.com/es/docs/starting-doc/Integrando/Fluxo%20de%20autoriza%C3%A7%C3%A3o/Authorization%20Code)
- [Aplicações e URI de redirecionamento](https://developers.empresas.btgpactual.com/es/docs/starting-doc/Integrando/Aplicativos/Caracter%C3%ADsticas)
- [Escopos Pix Cobrança](https://developers.empresas.btgpactual.com/es/docs/tecspecs/Banking%20-%20PixCashin-spec)
