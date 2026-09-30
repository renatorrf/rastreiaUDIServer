# Cliente: pré-cadastro do pedido e acesso por WhatsApp

## Fluxo

1. Ao criar a entrega, o serviço reutiliza/cria um contato por empresa e WhatsApp normalizado. Nome e endereço vêm do pedido. Não cria senha, usuário autenticável nem consentimento neste momento.
2. Pelo link de acompanhamento, `/cliente/cadastro?tracking=...` mostra primeiro nome e final do WhatsApp. O cliente só define/confirma uma senha de pelo menos 8 caracteres e aceita o uso dos dados.
3. A senha é armazenada com Argon2id, nunca devolvida pela API. O acesso fica em `/cliente/login`, usando WhatsApp com DDD + senha, sem exigir e-mail.
4. O pedido que originou a ativação e os pedidos compatíveis da mesma empresa são vinculados ao perfil. Pedidos futuros criados para esse contato já recebem o vínculo.
5. Se houver conta no mesmo WhatsApp em outra empresa, não se cria uma segunda senha: o cliente entra com a senha existente e o link do novo pedido. Só depois dessa autenticação o novo perfil é associado à identidade.
6. O histórico reúne os perfis ativados da identidade, e cada rastreio resolve a empresa pelo pedido autorizado, não pelo último perfil acessado.

Contatos sem telefone utilizável (incluindo pedidos de integração que omitem o número) não geram contas fictícias. A loja deve corrigir os dados antes da ativação. Registros arquivados não são reativados silenciosamente. Pedidos não sobrescrevem dados pessoais de perfis existentes.

## Segurança e limitações

- O link é uma credencial de **primeira ativação**: quem o possuir antes da ativação pode criar a senha. Entregue-o somente ao destinatário. Isto não comprova a posse do WhatsApp; não há envio de OTP, SMS ou mensagem WhatsApp neste fluxo.
- Tokens revogados/fora da carência de cadastro são recusados. A ativação bloqueia o perfil e serializa a criação da identidade por telefone. Não é possível redefinir uma senha usando outro link de rastreio.
- Contas antigas conservam hashes, senhas e login por e-mail. A migração habilita telefone apenas quando ele identifica uma única identidade exclusivamente cliente; números ambíguos e identidades operacionais mantêm o login legado. Não há fusão automática de contas.
- Login, refresh, cookies HttpOnly e expiração usam a infraestrutura existente. Endpoints de login/ativação têm limite de tentativas e respostas `no-store`.
- **Recuperação automática para contas novas sem e-mail ainda exige um canal confiável de verificação**, por exemplo OTP. A interface não promete envio inexistente; orienta procurar suporte. Não redefina senhas apenas porque alguém informa um número ou apresenta um link de entrega.
- Não mudar `NODE_ENV` nem inserir senhas no `.env` para este recurso.

## Implantação coordenada (não executada nesta alteração)

1. Revisar/backup da base e aplicar as migrations pendentes, incluindo `0050_customer_whatsapp_login.sql`, com `npm run db:migrate` no backend autorizado.
2. Publicar backend e worker compatíveis com o schema. A migração aceita os registros antigos; o novo código exige a coluna/funções novas.
3. Publicar o novo frontend. O contrato `/public/customers/register` mudou: versões antigas que enviam formulário completo/senha temporária precisam ser atualizadas.
4. Validar com um pedido de teste, ativação, login por número formatado (`+55 (34) ...`), histórico, rastreio, refresh e repetição da ativação. O script `npm run smoke:customer-portal` foi atualizado; ele grava fixtures na base configurada, portanto executar somente em ambiente autorizado.

## Arquivos principais

- Criados: migration 0050, `customer-preregistration.ts`, `customer-activation.ts`, teste PostgreSQL em memória `customer-activation.integration.test.ts`, teste de tela `customer-login.spec.ts` e este documento.
- Alterados no backend: criação de entregas, rotas de clientes, autenticação de identidade e smoke do portal.
- Alterados no frontend: portal/serviço do cliente, login, rotas, serviço/store/interceptor de autenticação e guia compartilhado de instalação.
- Design System: reutilizados tema escuro/verde, superfície de autenticação, formulários e feedback existentes. Sem novos tokens, bibliotecas, CSS local ou refatoração do app shell.
- UX: somente senha/confirmação, indicação do WhatsApp mascarado, carregamento/erro/repetição, prevenção de cliques duplicados e navegação dedicada ao cliente.

## Testes locais

- O teste de integração usa PostgreSQL/WASM (PGlite) com as migrations reais 0042, 0044–0047 e 0050 e RLS, sem ler `.env` e sem conexão à base compartilhada.
- Cobre pré-cadastro sem consentimento, deduplicação, nome único, telefone ausente, ativação, senha curta, consentimento obrigatório, login formatado, cookies/refresh, vínculos, isolamento, links expirados/revogados e rejeição de alteração de senha por rastreio.
- Frontend: testes de cadastro, login, falhas/carregamento, contratos HTTP, interceptores e larguras de 320 a 1280 px.

### Resultado desta revisão

- Backend: build e lint aprovados; 160 testes aprovados com `npm test -- --maxWorkers=2`. A execução sem limite de workers atingiu timeout em um teste antigo de horário de loja; a repetição com dois workers passou integralmente.
- Frontend: build de produção (TypeScript/templates) e lint dos arquivos alterados aprovados; suíte completa com 194 testes aprovados no ChromeHeadless, sem alerta de orçamento CSS.
- Inspeção visual local em 390 e 1280 px: cadastro e login preservam tema/legibilidade e navegação. Prévia isolada com respostas fictícias, sem cadastro real. O aviso `NG05604` dessa prévia decorre do service worker deliberadamente desativado; instalação/push reais não foram homologados nela.
- A checagem ampliada de tipos dos testes do backend (`tsc --noEmit --rootDir .`) ainda encontra erros antigos em fixtures de geo, realtime, app/env e route-list. O build de produção não inclui esses testes e passa. Não foram alterados arquivos alheios para suprimir esses avisos.
- Sem migração na base remota, deploy, geração de APK ou envio de notificações. Homologar o fluxo publicado após implantação coordenada.
