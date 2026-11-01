'use strict';

// Recomposição do schema "marketing" depois dos testes que derrubam e recriam as migrations 750/751 (marketing.schema.test e marketing.schema.execucao.models.test).
// O down da parte 1/2 derruba as tabelas com TUDO que as migrations posteriores acrescentaram (colunas, índices, checks, FKs); recriar só as partes 1 e 2 e algumas das posteriores
// deixava o schema pela metade para os arquivos seguintes no mesmo banco (ex.: review_requests sem error_code, publication_jobs sem as colunas do worker). Aqui entram TODAS as
// migrations posteriores à parte 2 que mexem em objetos de marketing, em ordem de versão, e o GRANT do papel de runtime que o preparo do banco descartável faz (disposableCluster.grantRuntime).
const path = require('node:path');

const DIR = path.resolve(__dirname, '../../migrations');
const POSTERIORES_A_PARTE_2 = [
  '20260101000752-marketing-template-immutability.js', '20260101000754-marketing-campaign-lifecycle.js', '20260101000756-marketing-kill-switch-log.js',
  '20260101000758-marketing-automation-definition.js', '20260101000759-marketing-attribution.js', '20260101000760-marketing-permissions-and-roles.js',
  '20260101000761-marketing-campaign-cost.js', '20260101000764-marketing-resolve-company-group.js', '20260101000765-marketing-public-read-models.js',
  '20260101000765-marketing-seo-page-lifecycle.js', '20260101000771-marketing-publication-jobs-one-active-per-version-channel.js', '20260101000772-marketing-automation-action-receipts.js',
  '20260101000775-marketing-content-types-trigger.js', '20260101000780-marketing-publication-worker-columns.js', '20260101000788-marketing-reminder-pendings.js',
  '20260101000789-marketing-review-requests-request-columns.js', '20260101000796-marketing-media-authorizations-and-derivatives.js', '20260101000797-marketing-media-authorizations-dimensions.js',
  '20260101000884-marketing-campaigns-mass-confirmation.js',
];

/** Reaplica (up idempotente) as partes 1 e 2, todas as posteriores e o GRANT do runtime. `admin` é a conexão de superusuário do teste. */
async function recomporMarketing(admin) {
  const qi = admin.getQueryInterface();
  for (const file of ['20260101000750-marketing-schema-parte-1.js', '20260101000751-marketing-schema-parte-2.js', ...POSTERIORES_A_PARTE_2]) await require(path.join(DIR, file)).up(qi);
  const [[role]] = await admin.query("SELECT 1 AS ok FROM pg_roles WHERE rolname = 'nayara_runtime'");
  if (role) await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA marketing TO nayara_runtime');
}

module.exports = { recomporMarketing, POSTERIORES_A_PARTE_2 };
