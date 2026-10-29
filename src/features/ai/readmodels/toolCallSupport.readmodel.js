'use strict';

const { sequelize } = require('../../../models');

/**
 * Consultas de apoio às chamadas de ferramenta (M9-D006). Único lugar de tools/toolCall* que fala SQL (archGuard AI-004:
 * consulta direta só em readmodels/). Sempre dentro da transação do tenant (RLS FORCE continua valendo).
 */
async function lockRunSequence(runId, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { replacements: { key: `ai.tool_calls:${runId}` }, transaction });
}

async function nextSequence(runId, transaction) {
  const [[{ n }]] = await sequelize.query('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM ai.tool_calls WHERE run_id = :runId', { replacements: { runId }, transaction });
  return Number(n);
}

/**
 * Insere a chamada se a chave (empresa, tool, idempotência) ainda não existe. Com duas conexões na mesma chave a segunda ESPERA a
 * primeira terminar e, se ela gravou, não insere (devolve false): nunca duas execuções.
 */
async function insertIfAbsent(r, transaction) {
  const [rows] = await sequelize.query(
    `INSERT INTO ai.tool_calls (id, group_id, company_id, run_id, seq, tool_name, tool_version, permission_code, risk_level,
        args_sanitized, args_hash, idempotency_key, status, created_by, updated_by)
     VALUES (:id, :groupId, :companyId, :runId, :seq, :toolName, :toolVersion, :permissionCode, :riskLevel,
        CAST(:argsSanitized AS jsonb), :argsHash, :idempotencyKey, 'REQUESTED', :userId, :userId)
     ON CONFLICT (company_id, tool_name, idempotency_key) DO NOTHING
     RETURNING id`,
    { replacements: { ...r, argsSanitized: JSON.stringify(r.argsSanitized) }, transaction }
  );
  return rows.length === 1;
}

module.exports = { lockRunSequence, nextSequence, insertIfAbsent };
