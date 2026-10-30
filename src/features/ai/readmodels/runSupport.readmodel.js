'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/**
 * Consultas de apoio ao registro de execução (M9-D005). Único lugar de orchestrator/runs que fala SQL (archGuard AI-004:
 * consulta direta só em readmodels/). Sempre dentro da transação do tenant (RLS FORCE continua valendo).
 */
async function acquireRunKeyLock(companyId, idempotencyKey, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { replacements: { key: `ai.runs:${companyId}:${idempotencyKey}` }, transaction });
}

/**
 * Trava da taxa por pessoa e agente (M9-D020, rajada): os pedidos simultâneos da mesma pessoa para o mesmo agente passam um de cada vez pela
 * contagem e pela abertura do run; sem ela todos contam o mesmo número e furam o limite. Vale até o fim da transação de abertura.
 */
async function acquireRateLock(companyId, userId, agentCode, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { replacements: { key: `ai.rate:${companyId}:${userId}:${agentCode}` }, transaction });
}

/**
 * Runs da pessoa que começaram nos últimos `windowSeconds` (contador de banco da taxa por pessoa, M9-D020). Com `agentName`, só os do agente
 * (a taxa é por usuário E agente, M9-D030). Sob RLS do tenant.
 */
async function countRecentRuns(companyId, userId, windowSeconds, transaction, agentName = null) {
  const rows = await sequelize.query(
    `SELECT count(*)::int AS n FROM ai.ai_runs WHERE company_id = :companyId AND user_id = :userId AND started_at > now() - make_interval(secs => :seconds)
       AND (CAST(:agentName AS text) IS NULL OR agent_name = :agentName)`,
    { replacements: { companyId, userId, seconds: windowSeconds, agentName }, transaction, type: QueryTypes.SELECT }
  );
  return rows[0].n;
}

module.exports = { acquireRunKeyLock, acquireRateLock, countRecentRuns };
