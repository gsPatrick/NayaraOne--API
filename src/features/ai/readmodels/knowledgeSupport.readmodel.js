'use strict';

const { sequelize } = require('../../../models');

/**
 * Trava de apoio ao conhecimento homologado (M9-D008). Único lugar de knowledge/ que fala SQL (archGuard AI-004: consulta
 * direta só em readmodels/). Serializa quem versiona ou homologa o mesmo fact_key na mesma empresa.
 */
async function acquireFactKeyLock(companyId, factKey, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { replacements: { key: `ai.knowledge:${companyId}:${factKey}` }, transaction });
}

module.exports = { acquireFactKeyLock };
