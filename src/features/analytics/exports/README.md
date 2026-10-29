# exports

Propósito: exportação do BI como job assíncrono, com mascaramento, MFA por risco, URL temporária e auditoria (M9-D701).
Entradas: `POST /analytics/exports` (alvo: painel, indicador ou detalhe pelo filtro assinado; empresa ou grupo; período; filtros), com `analytics:export` e a permissão do domínio.
Saídas: arquivo CSV mascarado no armazenamento de arquivos, linha em `analytics.export_jobs` (QUEUED -> RUNNING -> READY -> EXPIRED, ou FAILED), trilha de auditoria, log de acesso (`EXPORT_REQUEST`, `EXPORT_GENERATE`, `EXPORT_DOWNLOAD`), eventos `analytics.export.requested/ready/downloaded/expired` e aviso ao solicitante.

Arquivos (um por responsabilidade):
- `export.body.js` corpo do pedido -> plano congelado; `export.access.js` permissão e escopo (reaplicados pelo worker); `export.risk.js` risco por volume e MFA recente;
- `export.rows.js` conteúdo lido dos snapshots/read models/detalhe (nunca do OLTP); `export.csv.js` formato do arquivo;
- `export.request.js` o pedido; `export.worker.js` + `export.generate.js` a geração (FOR UPDATE SKIP LOCKED); `export.cleanup.js` expiração e job preso;
- `export.download.js` + `export.url.js` endereço assinado curto e entrega; `export.routes.js` as três rotas; `export.settings.js` os parâmetros do administrador.
Jobs: `src/engines/jobs/analyticsExportWorkerJob.js` e `analyticsExportCleanupJob.js`. Portas para outros módulos (lint BI-001): `src/engines/biExport/`.
