'use strict';

/**
 * M9-D650 / M9-D651 — entrada de cada fórmula dos KPIs de Obras a partir dos read models da M9-D618 (nunca do OLTP). Cada demanda dona declara as
 * consultas dos seus KPIs (inputs.custo.js, inputs.operacao.js); aqui ficam a leitura, o mapeamento (puro) e a origem do número: o instante do último
 * recálculo do read model (`snapshotAt`) e a versão dele, que o snapshot grava como sourceSnapshotAt e readModelVersion. Os read models guardam o ESTADO
 * de hoje (não há histórico por data-base): quem chama só pede a data de hoje de São Paulo. Sem obra no read model devolve null: nada é inventado.
 */
const { sequelize } = require('../../../../../models');
const { MODELS } = require('./models');

const QUERIES = Object.freeze({
  ...require('./inputs.custo').QUERIES, // M9-D650
});

const T = (model) => `analytics.${model}`;

async function query(sql, companyId, transaction) {
  const [rows] = await sequelize.query(sql, { replacements: { companyId }, transaction });
  return rows;
}

const pick = (row, fields) => Object.fromEntries(fields.map((f) => [f, row[f]]));
const later = (a, b) => (!a || new Date(b) > new Date(a) ? b : a);

/** Origem do número: o recálculo mais recente entre as linhas lidas e a maior versão do esquema do read model. */
function sourceOf(rows) {
  return {
    snapshotAt: rows.reduce((acc, r) => later(acc, r.sourceSnapshotAt || r.refreshedAt), null),
    version: rows.reduce((acc, r) => Math.max(acc, r.version), 1),
  };
}

/** Devolve { input, source } do KPI ou null quando não há base. `params` (do administrador) vai à fórmula junto da entrada. */
async function loadObraInput(code, scope, asOfDate, transaction) {
  const spec = QUERIES[code];
  const rows = await query(spec.sql, scope.companyId, transaction);
  if (!rows.length) {
    if (!spec.zeroWithoutRows) return null;
    const progress = await query(`SELECT source_snapshot_at AS "sourceSnapshotAt", refreshed_at AS "refreshedAt", version FROM ${T(MODELS.progress)} WHERE company_id = :companyId`, scope.companyId, transaction);
    if (!progress.length) return null;
    return { input: { asOfDate, [spec.key]: [] }, source: sourceOf(progress), params: spec.params ? await spec.params(scope, transaction) : {} };
  }
  return { input: { asOfDate, [spec.key]: rows.map((r) => pick(r, spec.fields)) }, source: sourceOf(rows), params: spec.params ? await spec.params(scope, transaction) : {} };
}

/** A empresa tem alguma linha em algum dos read models de Obras? Sem isso não há o que calcular nem o que publicar. */
async function hasObraData(companyId, transaction) {
  const exists = Object.values(MODELS).map((model) => `SELECT 1 FROM ${T(model)} WHERE company_id = :companyId`).join(' UNION ALL ');
  return (await query(`SELECT 1 FROM (${exists}) x LIMIT 1`, companyId, transaction)).length > 0;
}

module.exports = { loadObraInput, hasObraData };
