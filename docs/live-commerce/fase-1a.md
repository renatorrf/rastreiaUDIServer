# Fase 1A — catálogo administrativo e pacotes de lives

Implementação local de 21/10/2026. Esta entrega inicia a Fase 1 do planejamento; não equivale à conclusão de todo o catálogo público, estoque e carrinho.

## Menus entregues

| Perfil | Menu | Rota |
| --- | --- | --- |
| Gestor | Vendas → Catálogo | `/app/vendas/catalogo` |
| Gestor | Vendas → Meu pacote de lives | `/app/vendas/plano` |
| Master | Financeiro → Pacotes de lives | `/platform/pacotes-lives` |

O master administra condições e vínculos na mesma página, nas abas **Pacotes** e **Vínculos das unidades**. Não foi criado um menu vazio de estúdio. Entregadores e operadores não têm acesso ao catálogo administrativo nem aos custos. O gestor apenas consulta seu adicional, sem conceder limites para si mesmo.

## Fluxos disponíveis

- Produtos por unidade: nome, SKU, descrição, categoria, preço, custo, ativo/arquivado. Busca por nome/SKU, filtro por situação e páginas de 50 produtos.
- Categorias por unidade: criar, editar e arquivar. Arquivamento não exclui os registros.
- Valores monetários em centavos inteiros no servidor; entrada brasileira com vírgula no formulário.
- Edição com versão esperada: um cadastro desatualizado não sobrescreve a alteração de outra sessão.
- Pacotes: código, nome, mensalidade, quantidade mensal, duração máxima e público simultâneo. O formulário sugere 4 lives, 120 minutos e 200 espectadores; o preço sugerido é editável e não representa contratação aprovada.
- Alterar condições cria uma nova versão. Assinaturas anteriores continuam apontando para as condições contratadas.
- A versão atual pode ser retirada da oferta. Versões antigas não podem voltar à oferta.
- Vínculo por unidade com início/fim, motivo obrigatório, impedimento de períodos sobrepostos e cancelamento auditado.
- Esboços não salvos exigem confirmação para descarte; formulário em painel no desktop e modal até 1199px. Salvamento com estado ocupado, erro recuperável e idempotência.

Os limites de 120 minutos e 200 espectadores são **limites de configuração desta fase**, não prova de capacidade nem controle de uma transmissão. Não há consumo fictício: a consulta retorna `streamingAvailable: false` e `usage: null`.

## API implementada

Todos os endpoints são autenticados. As mutações exigem `Idempotency-Key`. Tenant, usuário e privilégios são derivados da sessão, nunca de campos enviados pelo frontend.

- `GET /commerce/stores`: unidades autorizadas do gestor, com busca/paginação.
- `GET/POST /commerce/stores/:storeId/products` e `PATCH /commerce/stores/:storeId/products/:id`.
- `GET/POST /commerce/stores/:storeId/categories` e `PATCH /commerce/stores/:storeId/categories/:id`.
- `GET /commerce/stores/:storeId/live-entitlement`: condições e histórico da própria unidade.
- `GET /platform/live-stores`: seleção de unidade para o master, com busca/paginação.
- `GET/POST /platform/live-plans`: consulta e publicação de versões.
- `PATCH /platform/live-plans/:id/availability`: oferta, revisão esperada e motivo.
- `GET/POST /platform/stores/:storeId/live-subscriptions`: histórico e contratação administrativa.
- `PATCH /platform/live-subscriptions/:id/cancel`: cancelamento com versão esperada e motivo.

Limites atuais das seleções: até 100 unidades por busca, 500 categorias por unidade, 100 contratos no histórico e 100 pacotes disponíveis na seleção de vínculo. O catálogo de produtos e a lista administrativa de pacotes têm paginação. Evoluir as seleções para paginação incremental antes de superar esses volumes.

## Banco e implantação

Migração: `0053_commerce_catalog_live_plans.sql`. Cria quatro tabelas, índices, FKs compostas e RLS. Não altera vínculos de usuários, não apaga registros, não cria pacotes padrão, assinaturas, faturas nem recursos AWS.

**Atualização de 21/10/2026: migração 0053 aplicada ao banco configurado, mediante autorização do responsável. Registro confirmado em 21/10/2026 às 16:28:48 (America/Sao_Paulo). Não houve deploy de frontend/backend.**

Verificação posterior em nova conexão: PostgreSQL 9.6.24, 53 migrações aplicadas e nenhuma pendente; quatro tabelas comerciais criadas com RLS habilitada e forçada, totalizando seis políticas. Todas permaneciam vazias, sem geração de pacotes ou contratos. O papel runtime não pode excluir produtos nem alterar os preços de versões contratadas; o acesso comercial sem identidade foi negado. Dados operacionais existentes não foram modificados pela migração. A execução e verificação estrutural nessa versão não substituem os testes de concorrência/E2E ainda pendentes.

Ordem de ativação, em janela autorizada:

1. Confirmar backup, banco de destino e estado das migrações (0052 deve estar aplicada). Usar a credencial de migração, não ampliar privilégios do runtime.
2. No banco configurado, 0053 já aplicada. Para outros ambientes, validar em PostgreSQL 9.6 isolado e executar `npm run db:migrate` no backend. O runner aplica todas as pendentes; conferir a lista antes.
3. Publicar backend compatível e verificar catálogo/pacotes com gestor e master em homologação.
4. Publicar frontend. Não publicar estes menus contra uma API antiga sem os endpoints novos.
5. Criar um pacote de teste e vincular somente uma unidade autorizada. Confirmar isolamento entre unidades/empresas e que a edição de versão não modifica o contrato existente.

Não são necessárias novas variáveis `.env` nesta fase. Credenciais existentes, VAPID, WhatsApp e iFood permanecem inalterados. Um vínculo de pacote ainda não gera cobrança, pagamento ou habilitação de vídeo.

## Validação local

- Backend: build, lint e 232 testes aprovados (incluindo 13 testes novos em PGlite).
- Frontend: build de produção sem aviso de budget e 290 testes aprovados; lint dos arquivos novos aprovado. A suíte geral mantém mensagens de fixtures antigas de `ion-menu`, sem falha de teste.
- Testes novos: isolamento entre tenants/unidades, bloqueio de operador/entregador, escrita RLS indevida, valores monetários, versões, arquivamento, idempotência, preservação de preço contratado, sobreposição e cancelamento, menus por perfil e proteção de formulário.
- Prévia de interface local usa as páginas reais com API fictícia, sem credenciais ou conexão ao backend. Validada em 320, 375, 390, 430, 768, 1024 e 1280px, sem overflow horizontal de documento. Cadastro móvel, loading e descarte de edição exercitados no navegador.
- Não realizado: E2E contra banco compartilhado, concorrência com múltiplas conexões PostgreSQL 9.6, integração de transmissão/cobrança ou validação publicada.

Para repetir a prévia no diretório do frontend:

```powershell
npx ng build --configuration development --browser tools/commerce-preview/main.ts --ts-config tools/commerce-preview/tsconfig.json --output-path .data/commerce-preview
node tools/commerce-preview/serve.mjs
```

Abrir `http://127.0.0.1:8139/catalogo`. A prévia não é importada pelo bootstrap/rotas de produção e não persiste dados; não valida a API real. Seu resultado fica separado de `www`.

## Continuação da Fase 1

Atualização: variantes, estoque/movimentos e publicação por slug foram implementados no recorte descrito em [Fase 1B](fase-1b.md), com a migração 0054 aplicada mediante autorização em 21/10/2026. Imagens e importação CSV/XLSX foram implementadas localmente na [Fase 1C](fase-1c.md), com a migração 0055 aplicada mediante autorização em 21/10/2026 às 18:05:41 (America/Sao_Paulo). O carrinho público persistente foi implementado na [Fase 1D](fase-1d.md), com migração 0056 preparada e ainda não aplicada. Identificação/merge, checkout e pedidos vêm na Fase 2. Transmissão Amazon IVS, controle efetivo de audiência/duração/cota e cobrança automática pertencem às próximas entregas. A prova de transmissão segue dependente da conta AWS.
