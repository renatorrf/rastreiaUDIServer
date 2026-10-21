# Fase 1C — imagens dos produtos e importação do catálogo

Continuação implementada em [Fase 1D — carrinho persistente](fase-1d.md), com migração 0056 preparada e ainda não aplicada.

Implementação local em 21/10/2026. **Migração 0055 aplicada ao banco configurado em 21/10/2026 às 18:05:41 (America/Sao_Paulo), mediante autorização explícita. Sem deploy e sem alterações no .env.**

## Entregue

- Menu gestor **Vendas → Importar catálogo**, também acessível pelo catálogo. Entregadores e operadores não recebem acesso; o backend exige TENANT_MANAGER e vínculo ativo com a unidade.
- **Catálogo → Fotos**: até seis fotos por produto, capa na primeira posição, ordenação, texto alternativo e remoção da exibição mediante salvar. A remoção arquiva metadados; não apaga objetos definitivamente.
- JPEG/PNG/WebP estáticos, até 5 MB/16 megapixels. O conteúdo é decodificado no backend (não basta extensão/MIME), orientado, reencodificado em WebP sem EXIF, limitado a 1600 px e acompanhado de miniatura de até 400 px. SVG, animações e arquivos corrompidos são recusados. Upload possui identidade de repetição e controle concorrente próprio da galeria.
- Fotos privadas são entregues por endpoint autenticado; no catálogo público apenas imagens de produtos/unidades/categorias elegíveis são servidas. Despublicar/arquivar impede novas consultas. Sem links públicos permanentes de storage; respostas no-store. Isso não revoga cópias já baixadas pelo visitante.
- Importação **CSV UTF-8 e XLSX**: arquivo → mapeamento → prévia → confirmação → resultado. Modelo CSV, amostra das primeiras cinco linhas, linhas ignoráveis, relatório de erros CSV protegido contra fórmulas e histórico dos últimos 20 arquivos da unidade.
- Chave de correspondência configurável: SKU ou código de barras. Modos incluir novos/ignorar existentes, atualizar existentes/ignorar novos, ou incluir e atualizar. SKU, nome e preço obrigatórios. Código de barras opcional no cadastro, de 8 a 14 dígitos e único na unidade; preserva zeros quando a origem é texto.
- Campos opcionais: descrição, categoria, custo, ativo e estoque. Campos não mapeados preservam valores existentes. Campos mapeados vazios limpam descrição/categoria/código de barras; custo, ativo e estoque mapeados exigem valor válido. Novos registros usam custo/estoque zero quando não mapeados, e ativo=true.
- Categorias novas são criadas dentro da confirmação; categorias arquivadas são recusadas. Produtos novos **não são publicados automaticamente**. A publicação existente não é alterada ao atualizar um produto.
- Estoque importado é o **saldo físico absoluto da variante padrão**, não um incremento. Diferenças usam a função controlada e o histórico imutável já existentes, com usuário/motivo; reservas são respeitadas. Outras variantes não são importadas nem alteradas.
- Confirmação exige senha atual do gestor e motivo. Senha não entra em auditoria, hash de idempotência ou resultado. O frontend limpa o campo após envio.

## Limites e integridade

Até **100 produtos, 30 colunas, 5 MB**, uma planilha XLSX por arquivo, até 2.000 caracteres por célula e 1 MB de conteúdo normalizado. Valores monetários aceitam 12,90 ou 12.90, sem separador de milhar e sem arredondamento implícito. Planilhas com fórmulas, links, datas/objetos nas células, macros, objetos incorporados ou vínculos externos são rejeitadas. ZIP é inspecionado e descompactado com limites antes da leitura XLSX (20 MB total, 8 MB por entrada, 1.000 entradas).

O arquivo original não é armazenado; são persistidos SHA-256 do arquivo, nome, conteúdo tabular limitado, autor/data, opções, prévia e resultado. A unicidade unidade+hash permite retomar o mesmo arquivo e impede reprocessar um já aplicado. Para uma revisão intencional, envie arquivo com conteúdo revisado e confira a prévia.

A prévia tem token e validade de 30 minutos. A confirmação não aceita produtos enviados pelo navegador: recompõe e compara o plano a partir dos dados persistidos. Verifica versões e bloqueia concorrência de cadastros; o estoque mantém a função controlada/versionada. O lote é transacional: qualquer falha impede aplicação parcial. Não há job em segundo plano nesta etapa: em timeout, retome pelo histórico ou repita a mesma confirmação; confira o resultado antes de tentar outro arquivo.

RLS forçada nas tabelas novas, chaves compostas tenant/unidade/produto e auditoria por usuário. Sem DELETE/DROP de dados operacionais. Arquivos de imagem arquivados e registros de importação ficam retidos; política de expurgo/quota total ainda deve ser definida antes de volume comercial alto. Falha ambígua de COMMIT não provoca exclusão cega de objetos: limpeza tenta confirmar ausência no banco com acesso válido; se não conseguir, mantém o objeto e registra aviso para reconciliação.

## Ativação

1. No banco configurado, `0055_commerce_media_imports.sql` já foi aplicada (barcode, versão da galeria, imagens, importações e projeções públicas). Em outros ambientes, confirmar backup, destino e pendências: `npm run db:migrate` aplica todas as pendentes.
2. A migração deve anteceder a publicação deste backend: consultas do catálogo usam as novas colunas/tabela. Execução e verificação estrutural confirmadas em PostgreSQL 9.6.24; isso não substitui homologação dos fluxos e concorrência.
3. Conferir armazenamento durável existente: `OBJECT_STORAGE_PROVIDER=s3`, bucket/região/endpoint/credenciais já previstos no projeto, mantidos somente no backend. Não é necessário tornar o bucket público. O modo local serve para desenvolvimento; arquivos locais do Cloud Run são efêmeros e não devem guardar fotos comerciais. Nenhuma infraestrutura foi provisionada nesta entrega.
4. Publicar backend e depois frontend. Confirmar CORS da origem Firebase/APK e abertura de `/loja/:slug`. A mídia pública ajusta Cross-Origin-Resource-Policy para a origem separada da API.
5. Homologar com uma unidade autorizada: cadastrar produto, enviar duas fotos, mudar capa/ordem, arquivar foto; publicar/ocultar produto e abrir catálogo anônimo. Tentar consultar foto por outra unidade/perfil.
6. Importar CSV e XLSX pequenos, revisar preços e saldo, confirmar com senha, repetir envio/confirmar resultado sem duplicação. Testar erros, linhas ignoradas, modo atualizar e edição concorrente entre prévia e confirmação. Verificar movimentos de estoque e auditoria. Sem testes reais nesta entrega.

## Validação local e pendências

Após a aplicação, uma nova conexão confirmou **55 migrações aplicadas e nenhuma pendente**. As duas tabelas novas têm RLS habilitada e forçada; barcode e media_version foram criados, com versão obrigatória/padrão 1. Confirmadas as funções públicas e seus privilégios: runtime sem DELETE de imagens, sem alteração das chaves de objetos/hash do arquivo e sem execução direta da projeção antiga. Consulta anônima de catálogo/foto inexistentes retornou lista vazia/NULL, sem visibilidade das tabelas privadas. Produtos, variantes e movimentos já estavam vazios e permaneceram assim; imagens e importações também vazias. Nenhum cadastro de teste ou dado operacional foi criado ou removido.

Builds de backend/frontend e lint dos arquivos alterados aprovados. **281 testes de backend em 52 arquivos e 310 de frontend aprovados**: parser/imagem, HTTP de autenticação/perfis/senha/escopo/multipart/idempotência, integração PostgreSQL isolada com PGlite (migração/RLS/importação/estoque/projeção pública, expiração e rollback integral por falha no segundo item) e testes frontend de confirmação/loading/duplicidade/galeria. Prévia responsiva em 320, 375, 390, 430, 768, 1024 e 1280 px, sem overflow horizontal; usa páginas reais com API fictícia, sem credenciais ou acesso ao banco. Comandos em `fase-1a.md`; rota adicional `/importacao` e links Fotos no catálogo.

Não validado: deploy Firebase/APK, bucket real/S3 do provedor, fluxo E2E no banco compartilhado e concorrência com várias conexões reais. Carrinho, checkout, importação de variantes e fotos por URL, vídeo IVS e cobrança permanecem fora deste recorte.

Auditoria npm do backend nesta entrega apontou 10 avisos em dependências já utilizadas (8 high, 2 moderate: Fastify, busboy, gRPC, engine.io, fast-uri, nodemailer, ip-address, brace-expansion, source-map-js e Vite). Não foi feito upgrade geral nem `audit fix --force`. ExcelJS recebeu override de UUID 11.1.1, validado pelos testes, evitando incorporar o aviso da versão transitiva antiga. **Resolver os avisos restantes em uma revisão de dependências antes da ativação comercial.**
