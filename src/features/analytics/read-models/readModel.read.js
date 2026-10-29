'use strict';

/**
 * M9-D607 — leitura de um agregado do read model e conferência da estrutura comum. `readAggregate` devolve a linha com
 * source_snapshot_at, refreshed_at e version; se o agregado ainda não existe, responde 200 com status INCOMPLETE e o código
 * ANALYTICS_READ_MODEL_EMPTY (nunca zero inventado). `assertReadModelTable` confere que a tabela do read model tem as colunas comuns
 * e o índice único (company_id, ...chave) que o UPSERT exige.
 */
const { sequelize } = require('../../../models');
const { IDENT } = require('./readModel.registry');

const COMMON = ['company_id', 'group_id', 'source_snapshot_at', 'refreshed_at', 'version'];
const EMPTY = Object.freeze({ code: 'ANALYTICS_READ_MODEL_EMPTY', message: 'Ainda não há dados para este indicador.' });

async function readAggregate(def, { companyId, key }, transaction) {
  const where = def.keyColumns.map((c) => `"${c}" = :k_${c}`).join(' AND ');
  const replacements = { companyId, ...Object.fromEntries(def.keyColumns.map((c) => [`k_${c}`, key[c]])) };
  const [rows] = await sequelize.query(`SELECT * FROM analytics."${def.name}" WHERE company_id = :companyId AND ${where} LIMIT 1`, { replacements, transaction });
  if (!rows.length) return { status: 'INCOMPLETE', ...EMPTY, data: null };
  return { status: 'OK', data: rows[0] };
}

/** Devolve a lista de problemas da tabela do read model (vazia = estrutura correta). */
async function assertReadModelTable(def, transaction) {
  if (!IDENT.test(def.name)) return [`nome inválido: ${def.name}`];
  const [cols] = await sequelize.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :name`, { replacements: { name: def.name }, transaction });
  const have = new Set(cols.map((c) => c.column_name));
  const problems = [...COMMON, ...def.keyColumns].filter((c) => !have.has(c)).map((c) => `falta a coluna ${c}`);
  const [idx] = await sequelize.query(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = to_regclass(:t) AND i.indisunique`, { replacements: { t: `analytics."${def.name}"` }, transaction });
  const unique = new Set(idx.map((r) => r.attname));
  if (!['company_id', ...def.keyColumns].every((c) => unique.has(c))) problems.push('falta o índice único (company_id, chave do agregado)');
  return problems;
}

module.exports = { readAggregate, assertReadModelTable, EMPTY };
