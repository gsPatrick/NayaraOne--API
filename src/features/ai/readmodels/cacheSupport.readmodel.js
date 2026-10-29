'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/**
 * Apoio SQL do cache seguro da NAY (M9-D015): ai.cache_entries e a conferência das fontes guardadas contra o índice do RAG (ai.chunks).
 * Único lugar do cache que fala SQL (archGuard AI-004). Sempre na transação do tenant (RLS FORCE por empresa).
 */
const COLUMNS = `id, key, scope_key AS "scopeKey", agent_code AS "agentCode", agent_version AS "agentVersion", task_type AS "taskType",
  value_json AS "valueJson", source_ids AS "sourceIds", provider_code AS "providerCode", model_code AS "modelCode", created_at AS "createdAt", expires_at AS "expiresAt"`;

const query = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

/** A entrada mais nova e ainda válida (não vencida) do escopo, ou null. */
async function findLive(companyId, scopeKey, now, transaction) {
  const rows = await query(`SELECT ${COLUMNS} FROM ai.cache_entries WHERE company_id = :companyId AND scope_key = :scopeKey AND expires_at > :now ORDER BY created_at DESC LIMIT 1`, { companyId, scopeKey, now }, transaction);
  return rows[0] || null;
}

/** Entrada pela chave completa (RLS: de outra empresa não aparece), vencida ou não. */
async function findByKey(companyId, key, transaction) {
  const rows = await query(`SELECT ${COLUMNS} FROM ai.cache_entries WHERE company_id = :companyId AND key = :key`, { companyId, key }, transaction);
  return rows[0] || null;
}

/** Grava a entrada; a mesma chave só renova o valor e a validade (nunca duplica). */
async function upsert(entry, transaction) {
  const rows = await query(
    `INSERT INTO ai.cache_entries (group_id, company_id, key, scope_key, agent_code, agent_version, task_type, value_json, source_ids, provider_code, model_code, created_at, expires_at)
     VALUES (:groupId, :companyId, :key, :scopeKey, :agentCode, :agentVersion, :taskType, CAST(:valueJson AS jsonb), CAST(:sourceIds AS jsonb), :providerCode, :modelCode, :now, :expiresAt)
     ON CONFLICT (company_id, key) DO UPDATE SET value_json = EXCLUDED.value_json, source_ids = EXCLUDED.source_ids, provider_code = EXCLUDED.provider_code,
       model_code = EXCLUDED.model_code, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
     RETURNING ${COLUMNS}`,
    { ...entry, valueJson: JSON.stringify(entry.valueJson), sourceIds: JSON.stringify(entry.sourceIds) }, transaction
  );
  return rows[0];
}

async function remove(companyId, id, transaction) {
  await sequelize.query('DELETE FROM ai.cache_entries WHERE company_id = :companyId AND id = :id', { replacements: { companyId, id }, transaction });
}

/** Apaga as entradas vencidas da empresa (limpeza oportunista a cada gravação). */
async function removeExpired(companyId, now, transaction) {
  await sequelize.query('DELETE FROM ai.cache_entries WHERE company_id = :companyId AND expires_at <= :now', { replacements: { companyId, now }, transaction });
}

/** Pares {sourceId, version} com chunk ACTIVE e vigente agora para os ids dados: o que ainda vale no índice. */
async function activeSourceVersions(companyId, sourceIds, now, transaction) {
  if (!sourceIds.length) return [];
  const rows = await query(
    `SELECT DISTINCT CAST(source_id AS text) AS "sourceId", CAST(source_version AS text) AS version FROM ai.chunks
      WHERE company_id = :companyId AND status = 'ACTIVE' AND CAST(source_id AS text) IN (:sourceIds)
        AND effective_from <= :now AND (effective_until IS NULL OR effective_until > :now)`,
    { companyId, sourceIds, now }, transaction
  );
  return rows;
}

module.exports = { findLive, findByKey, upsert, remove, removeExpired, activeSourceVersions };
