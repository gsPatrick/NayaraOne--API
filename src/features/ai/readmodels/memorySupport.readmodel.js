'use strict';

const { sequelize } = require('../../../models');

/**
 * Travas de apoio à memória da NAY (M9-D009). Único lugar de memory/ que fala SQL (archGuard AI-004: consulta direta só em
 * readmodels/). A chave de idempotência serializa duas gravações iguais; a trava do assunto serializa quem corrige a mesma memória.
 */
async function acquireMemoryLock(kind, companyId, key, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { replacements: { key: `ai.memory:${kind}:${companyId}:${key}` }, transaction });
}

module.exports = { acquireMemoryLock };
