'use strict';

/**
 * M9-D611 (3.1 e 3.2) — consultas à tabela de origem com o filtro canônico: contagem, amostra de ids, soma do campo monetário e linhas
 * para refazer a fórmula. O WHERE sai SÓ da especificação registrada (identificadores validados) e do filtro (valores por parâmetro).
 * Roda na transação do chamador, portanto sob o RLS da empresa.
 */
const { sequelize } = require('../../../models');

function buildWhere(spec, filter) {
  const col = (name) => `t."${name}"`;
  const replacements = { companyId: filter.companyId };
  const parts = [`${col(spec.companyColumn)} = :companyId`];
  const c = spec.columns || {};
  if (filter.period) {
    if (!c.period) throw new Error(`Origem ${spec.metricCode}: não declara coluna de período.`);
    if (filter.period.from) { parts.push(`${col(c.period)} >= :periodFrom`); replacements.periodFrom = filter.period.from; }
    if (filter.period.to) { parts.push(`${col(c.period)} < :periodTo`); replacements.periodTo = filter.period.to; }
  }
  for (const key of ['status', 'nature']) {
    if (!filter[key]) continue;
    if (!c[key]) throw new Error(`Origem ${spec.metricCode}: não declara coluna de ${key}.`);
    parts.push(`${col(c[key])} IN (:${key}List)`);
    replacements[`${key}List`] = filter[key];
  }
  Object.entries(filter.equals || {}).forEach(([name, value], i) => {
    const column = (c.equals || {})[name];
    if (!column) throw new Error(`Origem ${spec.metricCode}: filtro ${name} não é declarado.`);
    if (value === null) { parts.push(`${col(column)} IS NULL`); return; }
    parts.push(`${col(column)} = :eq${i}`);
    replacements[`eq${i}`] = value;
  });
  return { where: parts.join(' AND '), replacements };
}

const from = (spec) => `FROM ${spec.table.split('.').map((p) => `"${p}"`).join('.')} t`;

async function countRows(spec, filter, transaction) {
  const { where, replacements } = buildWhere(spec, filter);
  const [[row]] = await sequelize.query(`SELECT count(*)::int AS n ${from(spec)} WHERE ${where}`, { replacements, transaction });
  return row.n;
}

async function sampleIds(spec, filter, limit, transaction) {
  if (limit <= 0) return [];
  const { where, replacements } = buildWhere(spec, filter);
  const [rows] = await sequelize.query(
    `SELECT t."${spec.idColumn}"::text AS id ${from(spec)} WHERE ${where} ORDER BY t."${spec.idColumn}" LIMIT :limit`,
    { replacements: { ...replacements, limit }, transaction }
  );
  return rows.map((r) => r.id);
}

/** Soma exata (texto decimal) do campo monetário; linhas do sinal negativo entram subtraindo (ex.: pagamentos no caixa). */
async function sumValue(spec, filter, transaction) {
  if (!spec.valueColumn) throw new Error(`Origem ${spec.metricCode}: não declara valueColumn para o modo SUM.`);
  const { where, replacements } = buildWhere(spec, filter);
  const sign = spec.valueSign;
  const expr = sign ? `CASE WHEN t."${sign.column}" IN (:negatives) THEN -t."${spec.valueColumn}" ELSE t."${spec.valueColumn}" END` : `t."${spec.valueColumn}"`;
  const [[row]] = await sequelize.query(`SELECT COALESCE(SUM(${expr}), 0)::text AS total ${from(spec)} WHERE ${where}`, {
    replacements: { ...replacements, ...(sign ? { negatives: sign.negative } : {}) }, transaction,
  });
  return row.total;
}

/** Linhas completas (colunas de `rowColumns`) para refazer a fórmula; ordenadas pelo id para o resultado ser repetível. */
async function fetchRows(spec, filter, transaction) {
  const cols = (spec.rowColumns || []).map((c) => `t."${c}"::text AS "${c}"`);
  if (!cols.length) throw new Error(`Origem ${spec.metricCode}: não declara rowColumns para o modo RECOMPUTE.`);
  const { where, replacements } = buildWhere(spec, filter);
  const [rows] = await sequelize.query(`SELECT ${cols.join(', ')} ${from(spec)} WHERE ${where} ORDER BY t."${spec.idColumn}"`, { replacements, transaction });
  return rows;
}

module.exports = { buildWhere, countRows, sampleIds, sumValue, fetchRows };
