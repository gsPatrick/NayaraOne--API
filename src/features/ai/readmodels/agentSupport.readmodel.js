'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/**
 * Consultas de apoio ao registro de agentes (M9-D004). É o único lugar de agents/ que fala SQL: o archGuard (AI-004) só permite
 * consulta direta em readmodels/. Cada função recebe a transação do tenant (RLS FORCE continua valendo).
 */
async function acquireCodeLock(companyId, code, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { replacements: { key: `ai.agents:${companyId}:${code}` }, transaction });
}

async function evaluationsTableExists(transaction) {
  const [row] = await sequelize.query("SELECT to_regclass('ai.evaluations') AS t", { transaction, type: QueryTypes.SELECT });
  return Boolean(row.t);
}

async function passedEvaluationSuites(companyId, code, version, transaction) {
  const rows = await sequelize.query(
    "SELECT DISTINCT suite FROM ai.evaluations WHERE company_id = :companyId AND agent_code = :code AND agent_version = :version AND status = 'PASSED'",
    { replacements: { companyId, code, version }, transaction, type: QueryTypes.SELECT }
  );
  return new Set(rows.map((r) => r.suite));
}

module.exports = { acquireCodeLock, evaluationsTableExists, passedEvaluationSuites };
