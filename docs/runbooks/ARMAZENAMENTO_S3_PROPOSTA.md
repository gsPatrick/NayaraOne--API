# Armazenamento de objetos (S3 compatível): recomendação, custo, retenção, versionamento, backup e migração

Status: **adequação pendente, registrada como prevista no caderno** ("Definir armazenamento S3 compatível,
retenção e custo", decisão 4 da seção 19, e ARC-003: arquivos fora do banco, em armazenamento de objetos).
A Nayara não autorizou custo novo neste momento. Hoje os arquivos ficam em disco do servidor, **cifrados
(AES-256-GCM) e com SHA-256 conferido na leitura**, num volume persistente. Este documento é só a proposta.

## 1. Opções comparadas

Preços de tabela, em dólar, sem impostos nem IOF, consultados em 24/10/2026 nas páginas oficiais, salvo onde indicado.

| | AWS S3, região São Paulo | Cloudflare R2 | Backblaze B2 |
|---|---|---|---|
| Dados no Brasil | **sim** | não há região no Brasil | não há região no Brasil |
| Armazenamento por GB-mês | cerca de US$ 0,0405 (fonte de terceiros; confirmar na página da AWS) | US$ 0,015 (10 GB grátis) | US$ 0,00695 (10 GB grátis) |
| Transferência de saída | cobrada (100 GB/mês grátis, agregados) | **grátis** | grátis até 3x o volume guardado |
| Requisições | cerca de US$ 0,007 por mil gravações (SP, fonte de terceiros) | US$ 4,50 por milhão (gravação), US$ 0,36 por milhão (leitura) | gravação e leitura grátis na maioria |
| Versionamento e ciclo de vida | sim, maduro (inclui bloqueio de objeto) | ciclo de vida sim; versionamento a confirmar | a confirmar |
| API S3 | nativa | compatível | compatível |
| Magalu Cloud (Brasil) | preço não encontrado nas fontes públicas consultadas: **cotar** | | |

Estimativa mensal só de armazenamento:

| Volume | AWS S3 São Paulo | Cloudflare R2 | Backblaze B2 |
|---|---|---|---|
| 50 GB | cerca de US$ 2,03 | US$ 0,60 | US$ 0,28 |
| 200 GB | cerca de US$ 8,10 | US$ 2,85 | US$ 1,32 |
| 500 GB | cerca de US$ 20,25 | US$ 7,35 | US$ 3,41 |

Hoje a base de testes tem 74 MB em 8,5 mil arquivos; o volume real de produção ainda não existe.

## 2. Recomendação

**AWS S3 na região de São Paulo**, porque o caderno pede região brasileira ou estratégia compatível com privacidade (LGPD),
porque tem versionamento, ciclo de vida e bloqueio de objeto maduros, e porque o custo, mesmo no maior cenário, é pequeno.
Se a Nayara priorizar o menor custo e aceitar dados fora do Brasil (o que exige avaliação de LGPD e contrato de tratamento
de dados), a alternativa é o Cloudflare R2, sem custo de saída. Em qualquer caso o código é o mesmo, porque o formato é S3.

## 3. Retenção, versionamento e backup (propostos; valores configuráveis)

- **Versionamento ligado** no bucket: substituir um arquivo nunca apaga o anterior.
- **Exclusão lógica**: o sistema não apaga o objeto; versões antigas e não correntes ficam por **90 dias** e depois saem por ciclo de vida (prazo configurável; contratos e documentos jurídicos podem exigir mais, a definir pela Nayara).
- **Camadas de custo**: objetos sem leitura há 180 dias passam para a camada de acesso infrequente (opcional).
- **Backup**: replicação do bucket para uma segunda região ou conta (opcional, custo dobra) e, no mínimo, o backup do banco, que guarda os metadados e os hashes. A chave de criptografia dos arquivos (`FILES_ENCRYPTION_KEY`) fica em cofre separado: **sem ela os arquivos restaurados não abrem**.
- **Acesso**: bucket privado, usuário de serviço com permissão mínima, URLs temporárias assinadas para download, criptografia no servidor ligada (além da cifra já aplicada pelo sistema).

## 4. Plano de migração (sem parada)

1. Criar o bucket (privado, versionamento, criptografia) e o usuário de serviço; guardar as credenciais como segredo do ambiente, nunca no código.
2. Acrescentar a coluna `storage_provider` ao cadastro de arquivos (migration) e um adaptador `S3Storage` atrás da mesma interface de `diskStorage` (gravar, ler, apagar por chave). Arquivos antigos seguem como `disk`.
3. Copiar os blobs existentes para o bucket **como estão (já cifrados)**, conferindo o SHA-256 de cada um contra o manifesto de `scripts/backupStorage.js`.
4. Virar a escrita para o S3 (novos arquivos gravam no S3, leitura procura primeiro no S3 e depois no disco).
5. Manter o disco em somente leitura por 30 dias; depois remover.
6. Plano de volta: enquanto o disco existir, basta voltar o provedor de escrita para `disk`; nada é perdido.

Etapa prevista para conclusão: **depois da autorização de custo pela Nayara**; o trabalho de código e da migração é estimado em poucos dias de desenvolvimento mais a janela de cópia.

Fontes dos preços: páginas de preço da [Cloudflare R2](https://developers.cloudflare.com/r2/pricing/), do [Backblaze B2](https://www.backblaze.com/cloud-storage/pricing) e, para o S3 de São Paulo, um [guia de preços de 2026 de terceiros](https://upstash.com/blog/aws-s3-pricing-explained-2026), a confirmar na página da AWS.
