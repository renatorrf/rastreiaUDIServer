# Perfis de atividade e observações de preparo

## Estrutura implementada

O perfil operacional fica na empresa (`companies.business_activity`) e é herdado pelas suas unidades. Ele define sugestões e campos dos formulários, não substitui CNAE nem altera produtos existentes.

| Atividade | Variações | Sugestão para novos produtos | Observações de preparo |
| --- | --- | --- | --- |
| Comércio geral | Tamanho e cor, opcionais | Com estoque | Não habilitadas por padrão |
| Roupas e acessórios | Tamanho e cor; SKU e saldo por variante | Com estoque | Não habilitadas |
| Calçados | Numeração e cor; SKU e saldo por variante | Com estoque | Não habilitadas |
| Alimentação / lanchonete | Tamanho / porção; cor oculta, salvo dados antigos | Produção sob encomenda | Habilitadas, podendo desativar por produto |

Atividade e regra de estoque são independentes: uma lanchonete pode vender sanduíches produzidos sob encomenda e refrigerantes com estoque. Também é possível manter produtos sob encomenda em outras atividades, por exemplo roupas personalizadas.

Fluxo de dados: empresa → unidade → produto → variantes → itens do carrinho. Cada variante conserva SKU, preço e saldo próprios. As variações atuais são cadastradas individualmente; não foi adicionado um gerador automático de combinações tamanho × cor.

## Administração

1. No acesso master, selecionar a atividade ao cadastrar/provisionar ou editar a empresa.
2. Abrir **Vendas → Catálogo** da unidade e cadastrar o produto.
3. Conferir **Disponibilidade** (estoque ou produção sob encomenda). Em alimentação, conferir **Aceita observações de preparo**.
4. Em **Estoque / variantes**, cadastrar tamanhos, numerações ou porções e cores conforme a atividade. Para produtos sob encomenda, a tela informa o modo de produção em vez de mostrar “sem estoque”. Eles não entram nos filtros de estoque baixo/zerado.
5. Publicar o catálogo da unidade e habilitar cada produto na vitrine. Atividade não publica produtos automaticamente.

Empresas existentes iniciam em `GENERAL`. Alterar a atividade não converte estoque, não apaga variações e não habilita observações nos produtos já cadastrados. Para uma lanchonete existente, selecionar a atividade e revisar os produtos desejados individualmente.

## Cliente e carrinho

- Produtos que aceitam observações avisam isso no catálogo e abrem o carrinho após adicionar.
- Observações de até 500 caracteres, por exemplo “sem alface, molho à parte”.
- O texto fica associado à linha da variante e vale para toda sua quantidade. Para preparos diferentes da mesma variante, o cliente deve identificar as unidades no texto; ainda não existem linhas separadas de personalização para a mesma variante.
- Observações não adicionam ingredientes pagos, não alteram preços e não reservam estoque.
- Alterar apenas a quantidade ou atualizar o carrinho preserva as observações.
- As mutações mantêm posse do carrinho, versão, idempotência, escopo de loja/empresa e verificação de disponibilidade no servidor. Repetir uma requisição antiga não sobrescreve uma observação mais recente.
- Em conexão interrompida, a operação pendente mantém o texto para sincronização; os botões ficam bloqueados durante a gravação.

## Limites e próximas etapas

O catálogo e o carrinho já existiam sem checkout. Esta alteração não cria pagamentos ou pedidos comerciais finais. Na futura finalização, copiar produto/variante, quantidade, preço e observações para um retrato imutável dos itens do pedido, visível à loja/preparo.

Para adicionais cobrados (bacon, queijo extra), mapear entidades próprias: grupo de complementos → opções → limites mínimo/máximo → preços → escolhas por item. Não interpretar texto livre como autorização de cobrança. Ficha técnica/baixa de ingredientes, múltiplas personalizações da mesma variante, cozinha e geração automática de combinações não estão implementadas nesta etapa.

## Migração e implantação

- Arquivo: `migrations/0059_business_activity_preparation_notes.sql`.
- Acrescenta atividade da empresa, permissão de observações no produto e texto no carrinho.
- Mantém a função antiga de alteração do carrinho e adiciona uma função compatível com observações; versões antigas do cliente continuam enviando apenas quantidade.
- Não altera cadastros reais para FOOD, não converte saldos e não modifica segredos.
- Ordem: aplicar 0059 com o executor padrão, publicar backend e depois frontend. A migração foi preparada/testada em PostgreSQL isolado via PGlite, não executada no banco compartilhado nesta tarefa. PostgreSQL 9.6 real e ambientes hospedados ainda exigem validação após implantação autorizada.

## Validação local

- 96 testes do backend de comércio/organização passaram.
- 44 testes do frontend de comércio/carrinho passaram.
- Build de produção frontend e build TypeScript backend passaram.
- Lint backend e dos arquivos frontend alterados passou. A verificação mais ampla da pasta commerce também encontrou uma infração anterior em `catalog-import.page.html:21` (`!=`), fora das alterações desta tarefa.
- Suíte completa backend: 310 passaram, cinco falharam em `workday.integration.test.ts` (lembrete, confirmação/check-in e tracking), módulo não alterado. Não considerar a suíte geral verde. O fixture usa horário real com fechamento às 23h e a execução foi após esse horário; a causa definitiva dessas falhas requer análise separada.
- Prévia isolada, sem acesso ao banco real: cadastro de produto alimentar e carrinho; observação salva com preço preservado, loading de gravação, layouts mobile e desktop.

## UX

Mantidos tema escuro, componentes Ionic e padrões globais existentes. A skill de frontend orientou campos condicionais e textos operacionais curtos, sem criar painéis ou estilos concorrentes. Nenhuma dependência visual foi adicionada.
