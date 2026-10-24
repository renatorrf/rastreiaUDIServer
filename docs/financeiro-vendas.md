# Financeiro das vendas — migração 0063

## Decisões confirmadas

- DRE **gerencial por competência**: venda reconhecida quando o pedido comercial chega a `COMPLETED`.
- Recebimento/pagamento separado: concluir o pedido não significa dinheiro recebido.
- Mercadorias: custo médio ponderado pelas entradas. Produção sob encomenda: custo estimado da variante.
- Sem adivinhação: custos antigos ausentes ficam pendentes; lucro dependente deles aparece como **a apurar**, não como lucro com custo zero.

## Operação

Gestor → Vendas → **Financeiro de vendas**, `/app/vendas/financeiro`.

1. Escolher unidade e período (até 366 dias).
2. Em **Tipos**, adicionar os tipos padrão. Também é possível criar tipos próprios, com classificação na DRE.
3. Em **Estoque**, definir o custo inicial das variantes com saldo desconhecido, justificando a origem. Essa operação só permite preencher custo ausente; não sobrescreve o custo médio conhecido.
4. Em **Estoque e variantes → Movimentar**, informar o custo unitário de cada entrada. Compra/recebimento inicial usa `ENTRY`; ajuste positivo de inventário usa `ADJUSTMENT` e representa acréscimo patrimonial na DRE, não uma compra.
5. Registrar as compras em **Lançamentos → Compra de mercadorias / insumos**. Essa categoria afeta contas a pagar/caixa, não deduz o estoque novamente na DRE.
6. Registrar despesas com competência, vencimento, valor e documento opcional. Abrir o lançamento para baixar pagamentos/recebimentos, inclusive parciais.
7. Para corrigir uma baixa, estornar com data e motivo. Para corrigir lançamento manual, estornar as baixas ativas, cancelar com motivo e criar o correto. Nada é apagado.

Tipos padrão: vendas avulsas, impostos sobre vendas, descontos/devoluções, taxas de cartão/marketplace, fretes, comissões, embalagens, aluguel, água/energia, internet/telefone, salários/encargos, pró-labore, contabilidade/serviços, marketing, manutenção, softwares, depreciação/amortização, rendimentos, juros/tarifas, tributos sobre lucro, mercadorias/insumos, equipamentos, retirada de lucros, amortização de empréstimos e aportes/empréstimos recebidos.

**Depreciação** e **CMV de vendas externas ao catálogo** são lançamentos não monetários: participam da DRE, mas não podem receber baixa nem integrar contas a pagar. Use o CMV manual somente para vendas que não têm custo automático no app; não duplique o CMV de pedidos comerciais. Compras de estoque, investimentos, principal de empréstimos e distribuição de lucros são classificados como **somente caixa**. Não confundir retirada de lucros com pró-labore.

## Custo, resultado e projeção

- Média = `(quantidade anterior × custo médio anterior + quantidade recebida × custo recebido) / quantidade final`. Precisão interna: seis casas em centavos; arredondamento monetário na agregação.
- Saldo anterior com custo desconhecido continua desconhecido após uma compra, até a definição documentada do custo de todo o saldo. Entrada com saldo anterior zero pode iniciar uma média conhecida.
- Confirmação do pedido retira estoque e congela o custo. A conclusão reconhece receita e CMV na mesma competência. Alterar preços/custos depois não reescreve essa venda.
- Cancelar antes da conclusão não gera receita. A devolução de um pedido confirmado retorna ao estoque pelo custo congelado, sem usar o último preço de compra.
- Produção usa o custo estimado positivo da variante no momento da confirmação; zero herdado do cadastro é tratado como não informado. Não há ficha técnica/BOM nem consumo automático de ingredientes nesta entrega.
- Importação de saldo positivo é uma entrada, não ganho de inventário. Só uma coluna de custo explicitamente mapeada valoriza essas unidades; sem ela, o custo é desconhecido.
- Perdas, consumo e saídas manuais sem pedido entram no resultado pelo custo da saída. Movimentos vinculados a pedidos não são contados novamente como despesa.
- Projeção = saldo disponível não reservado de variantes/produtos ativos × preço atual, inclusive ainda não publicados. Exclui produção sob encomenda e itens inativos. É potencial de venda, não previsão de demanda nem receita garantida.
- Valor do estoque inclui saldo físico reservado e inativo; projeção e posição são **atuais**, não retroativas ao período selecionado da DRE.
- As linhas da DRE incluem receita bruta, deduções, receita líquida, CMV, lucro bruto, despesas variáveis/fixas, ajustes/perdas de estoque, EBITDA, depreciação, resultado operacional, resultado financeiro, tributos sobre lucro e resultado líquido.
- Caixa preserva a data original de cada baixa e registra sua reversão na data do estorno. Os compromissos são os saldos **atuais de todos os vencimentos**, não apenas os da competência filtrada.

## Histórico e limites explícitos

A migração traz pedidos comerciais já concluídos para a receita histórica, usando o evento de conclusão (ou `updated_at` se não houver evento). **Não inventa CMV passado nem cria contas antigas a receber como se estivessem inadimplentes.** Essas vendas ficam marcadas como legado. Definir custo do saldo atual não regulariza o CMV histórico. A conciliação histórica precisa de documentos e de uma rotina futura própria; não alterar tabelas manualmente para ocultar pendências.

Reconhecimento automático cobre `commerce_orders` do catálogo/live. Entregas operacionais/iFood, vendas fora do catálogo, impostos, tarifas, despesas e liquidações de adquirentes **não são importados automaticamente**. Não duplique a receita de um pedido comercial em “Vendas avulsas”.

Esta entrega não inclui pagamento online, conciliação bancária, saldo inicial de bancos/caixas, transferência entre contas, fechamento contábil de períodos, consolidação de várias unidades, cálculo tributário, parcelamento/recorrência automática, devolução pós-conclusão integrada a crédito de CMV ou reconciliação de custo histórico. Uma dedução manual de devolução não reverte automaticamente estoque/CMV nem quita a conta a receber original. Não usar esse lançamento isolado como fluxo completo de devolução.

Os relatórios são gerenciais dos dados registrados, não uma DRE fiscal/estatutária certificada. Classificações e impostos precisam ser conferidos com a contabilidade.

## Segurança e integridade

- Exclusivo para `TENANT_MANAGER`, derivando tenant/usuário da sessão e verificando acesso à unidade antes de leituras ou replay de idempotência.
- FORCE RLS e chaves compostas entre tenant/unidade em categorias, lançamentos, baixas e vendas reconhecidas.
- Valores em centavos, datas válidas, limites de período/paginação; APIs rejeitam `tenantId`, identidade, preço e classificação indevida no payload.
- Escritas idempotentes, versão otimista, bloqueio da linha de lançamento para baixas/estornos concorrentes e auditoria.
- Triggers também impedem pagamentos maiores que o saldo, baixas de depreciação/cancelados, estornos repetidos e cancelamento de venda automática.
- Custos privados dos itens não ganham permissão de leitura para o runtime e não entram no DTO de clientes.
- Nenhum segredo ou nova variável `.env`; nenhuma credencial foi alterada.

## Arquivos principais

- `migrations/0063_commerce_finance.sql`: custo médio, snapshots, tabelas, índices, RLS, reconhecimento, guardas e legado.
- `src/modules/commerce/finance.schemas.ts`, `finance.service.ts`, `finance.routes.ts`: contratos, regras, agregados e endpoints.
- `src/modules/commerce/inventory.schemas.ts`, `inventory.service.ts`, `catalog-import.service.ts`: custo de entradas/importação.
- `src/app.ts`: registro das rotas.
- `src/modules/commerce/commerce.integration.test.ts`, `finance-security.test.ts`: integração real com PostgreSQL embarcado/PGlite e fronteira HTTP.
- Frontend: `src/app/pages/commerce/finance.page.ts/.html/.scss`, `finance.spec.ts`, `src/app/core/api/commerce-finance.types.ts`, rota/menu, formulários de estoque e testes.

## Implantação

1. Backup verificado e janela coordenada. Conferir as migrações pendentes; o script padrão aplica todas as pendentes, não apenas uma por argumento.
2. Com autorização, aplicar `0063_commerce_finance.sql` pelo mecanismo `npm run db:migrate`, usando a conexão proprietária de migrações já adotada pelo projeto, não o papel runtime.
3. Publicar backend; o novo código de estoque depende da função criada na 0063. Depois publicar frontend.
4. Validar com gestor em homologação: tipos padrão, entrada de estoque com custo, pedido confirmado/concluído, receita sem caixa, recebimento parcial e estorno; verificar isolamento com outra unidade e conta de entregador.
5. Conferir custos de abertura e despesas reais antes de usar indicadores para decisões.

**24/10/2026: migração 0063 aplicada no banco configurado, após backup preventivo. Registro da migração, funções e RLS conferidos; nenhuma migração pendente. Publicação da aplicação é uma etapa separada.**

## Referências de desenho

- [CPC 16 — resumo oficial sobre estoques e apropriação ao resultado](https://static.cpc.aatb.com.br/Documentos/244_CPC_16_Sumario.pdf).
- [CPC 16 (R1), publicado pela CVM](https://conteudo.cvm.gov.br/export/sites/cvm/menu/regulados/normascontabeis/cpc/CPC_16_R1_rev_12.pdf).
- [Sebrae — apuração da DRE](https://www.sebraeplay.com.br/content/apuracao-do-dre).

As referências orientam o desenho gerencial; não representam certificação de conformidade contábil.
