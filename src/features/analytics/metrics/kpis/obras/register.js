'use strict';

/**
 * M9-D650 / M9-D651 — publicação idempotente (versão 1) dos KPIs de Obras no registry da empresa. Chamada pelo materializador antes da primeira
 * gravação; um código já publicado (inclusive por corrida entre dois workers) não é erro. Contexto interno do worker de BI.
 */
const AppError = require('../../../../../utils/AppError');
const { sequelize } = require('../../../../../models');
const { publishMetric } = require('../../registry.service');
const { P } = require('../../../security/permissionCatalog');
const { KPI_DEFINITIONS, publishInput } = require('./definitions');

const workerCtx = (scope) => ({ groupId: scope.groupId, companyId: scope.companyId, actorUserId: null, permissions: [P.MANAGE] });

async function isPublished(code, scope, transaction) {
  const [rows] = await sequelize.query(
    "SELECT 1 FROM analytics.metric_definitions WHERE metric_code = :code AND company_id = :companyId AND status = 'PUBLISHED' AND current_version_id IS NOT NULL LIMIT 1",
    { replacements: { code, companyId: scope.companyId }, transaction }
  );
  return rows.length > 0;
}

async function ensureObraKpisPublished(scope, transaction) {
  for (const def of KPI_DEFINITIONS) {
    if (await isPublished(def.metricCode, scope, transaction)) continue;
    try {
      await sequelize.transaction({ transaction }, async (savepoint) => publishMetric(await publishInput(def, scope, savepoint), workerCtx(scope), savepoint));
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'ANALYTICS_METRIC_CODE_DUPLICATE') throw err;
    }
  }
}

module.exports = { ensureObraKpisPublished };
