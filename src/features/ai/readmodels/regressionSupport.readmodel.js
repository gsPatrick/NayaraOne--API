'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/**
 * Consultas de apoio à regressão da NAY (M9-D033): quais suítes de avaliação passaram para um hash ou para um par provider/modelo.
 * Único lugar da regressão que fala SQL (o archGuard só permite consulta direta em readmodels/). Sempre na transação do tenant.
 */
async function passedSuitesForHashes(companyId, code, version, { configHash, globalHash, homologated = false }, transaction) {
  const rows = await sequelize.query(
    `SELECT DISTINCT suite FROM ai.evaluations
      WHERE company_id = :companyId AND agent_code = :code AND agent_version = :version AND status = 'PASSED'
        AND metrics ->> 'configHash' = :configHash AND metrics ->> 'globalHash' = :globalHash
        ${homologated ? 'AND homologated_by IS NOT NULL' : ''}`,
    { replacements: { companyId, code, version, configHash, globalHash }, transaction, type: QueryTypes.SELECT }
  );
  return new Set(rows.map((r) => r.suite));
}

/**
 * Suítes PASSED para o par (provider e, se informado, modelo), de qualquer versão; com `agentCode`, só do agente. A suíte
 * adversarial não chama o modelo (modelo nulo na linha): conta para o provedor informado.
 */
async function passedSuitesForPair(companyId, { agentCode = null, provider, model = null }, transaction) {
  const rows = await sequelize.query(
    `SELECT DISTINCT suite FROM ai.evaluations
      WHERE company_id = :companyId AND status = 'PASSED' AND provider_code = :provider
        AND (CAST(:model AS text) IS NULL OR model_code = :model OR model_code IS NULL)
        AND (CAST(:agentCode AS text) IS NULL OR agent_code = :agentCode)`,
    { replacements: { companyId, provider, model, agentCode }, transaction, type: QueryTypes.SELECT }
  );
  return new Set(rows.map((r) => r.suite));
}

module.exports = { passedSuitesForHashes, passedSuitesForPair };
