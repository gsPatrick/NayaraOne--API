'use strict';

const { sequelize } = require('../../../models');

/**
 * Apoio SQL do RAG (M9-D022). Único lugar de retrieval/ que fala SQL (archGuard AI-004: consulta direta só em readmodels/).
 *  - trava de ingestão por fonte (duas ingestões do mesmo conteúdo viram um índice só).
 */
async function acquireIngestionLock(companyId, sourceKind, sourceId, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { replacements: { key: `ai.ingestion:${companyId}:${sourceKind}:${sourceId}` }, transaction });
}

module.exports = { acquireIngestionLock };
