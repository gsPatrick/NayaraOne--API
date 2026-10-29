'use strict';

/**
 * M9-D624 — monta, para uma empresa e data-base, o resultado de cada KPI financeiro e as entradas de snapshot (principal + dimensões) a partir
 * da linha de rm_finance_health. Serve ao cálculo normal (finance.materialize) e à correção do rebuild (financeKpiCorrections, M9-D608).
 */
const { sequelize } = require('../../../../models');
const { getFormulaCatalog } = require('../formulaCatalog');
const { calcHash } = require('../calcHash');
const { buildSourceRefs } = require('../sourceRefs.build');
const { readStatementMaxAgeDays } = require('../../read-models/financeKpi.settings');
const { readResultParams } = require('../../read-models/financeResults.settings');
const { EXTRAS } = require('./finance.results');
const { P } = require('../../security/permissionCatalog');
const { KPI_DEFINITIONS, SOURCE_READ_MODEL } = require('./finance.definitions');
const { INPUTS, paramsOf } = require('./finance.inputs');
require('../sourceSpecs.finance');

async function loadRow(companyId, asOfDate, transaction) {
  const [rows] = await sequelize.query(`SELECT * FROM analytics.${SOURCE_READ_MODEL} WHERE company_id = :companyId AND as_of_date = :asOfDate`, {
    replacements: { companyId, asOfDate }, transaction,
  });
  return rows[0] || null;
}

async function publishedVersion(code, companyId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT d.id AS "metricId", v.id AS "metricVersionId", v.version, v.unit FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id
      WHERE d.metric_code = :code AND d.company_id = :companyId AND d.status = 'PUBLISHED'`, { replacements: { code, companyId }, transaction });
  return rows[0];
}

/** Uma entrada por snapshot: o valor principal (dimensão vazia) e uma por dimensão que a fórmula devolve. */
const snapshotInputs = (base, result) => [
  { ...base, dimensionKey: '', valueNumeric: result.value },
  ...(result.dimensions || []).map((d) => ({ ...base, dimensionKey: d.key, valueNumeric: d.value })),
];

/** Devolve [{ code, result, inputs }] (um por KPI publicado). Sem linha do read model na data, devolve lista vazia. */
async function buildFinanceKpiEntries(scope, asOfDate, transaction) {
  const row = await loadRow(scope.companyId, asOfDate, transaction);
  if (!row) return [];
  const settings = { maxStatementAgeDays: await readStatementMaxAgeDays(scope, transaction), ...(await readResultParams(scope, transaction)) };
  const sourceCtx = { groupId: scope.groupId, companyId: scope.companyId, permissions: [P.READ] };
  const catalog = getFormulaCatalog();
  const out = [];
  for (const def of KPI_DEFINITIONS) {
    const published = await publishedVersion(def.metricCode, scope.companyId, transaction);
    if (!published) continue;
    const extra = EXTRAS[def.metricCode] ? await EXTRAS[def.metricCode](scope, asOfDate, transaction) : undefined; // M9-D623: a margem lê também os setores do mês
    const inputs = INPUTS[def.metricCode](row, asOfDate, extra);
    const params = paramsOf(def.metricCode, settings);
    const result = catalog.get(def.formulaId).compute(inputs, params);
    const { sourceRefs } = await buildSourceRefs(sourceCtx, def.metricCode, { filter: (row.source_criteria || {})[def.metricCode], unit: published.unit }, transaction);
    const base = {
      metricId: published.metricId, metricVersionId: published.metricVersionId, groupId: scope.groupId, companyId: scope.companyId, scopeType: 'COMPANY', scopeId: scope.companyId,
      periodStart: asOfDate, periodEnd: asOfDate, asOfDate, status: result.status, sourceSnapshotAt: row.source_snapshot_at, readModelVersion: row.version,
      sourceRefs, calcHash: calcHash({ metricCode: def.metricCode, version: published.version, inputs, params }),
    };
    out.push({ code: def.metricCode, result, inputs: snapshotInputs(base, result) });
  }
  return out;
}

module.exports = { buildFinanceKpiEntries };
