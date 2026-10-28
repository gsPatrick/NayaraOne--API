'use strict';

const { sequelize } = require('../../../models');

/**
 * Consultas de apoio ao registro de execução (M9-D005). Único lugar de orchestrator/runs que fala SQL (archGuard AI-004:
 * consulta direta só em readmodels/). Sempre dentro da transação do tenant (RLS FORCE continua valendo).
 */
async function acquireRunKeyLock(companyId, idempotencyKey, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { replacements: { key: `ai.runs:${companyId}:${idempotencyKey}` }, transaction });
}

module.exports = { acquireRunKeyLock };
