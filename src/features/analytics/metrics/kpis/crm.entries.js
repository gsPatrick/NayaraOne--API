'use strict';

/**
 * M9-D630 / M9-D631 — monta, para uma empresa e data-base, o resultado de cada KPI do funil comercial e as entradas de snapshot (principal + dimensões)
 * a partir dos read models do CRM. Serve ao cálculo normal (crm.materialize) e ao snapshot diário (crm.snapshotProvider, M9-D609). A fonte é sempre
 * o estado atual do read model: por isso o cálculo de uma data passada só vale para o que a fonte guarda por dia (ver crm.snapshotProvider).
 */
const { sequelize } = require('../../../../models');
const { getFormulaCatalog } = require('../formulaCatalog');
const { calcHash } = require('../calcHash');
const { buildSourceRefs } = require('../sourceRefs.build');
const { readCrmKpiParams } = require('../../read-models/crmKpi.settings');
const { readComercialParams } = require('../../read-models/comercial.settings');
const { getReadModel } = require('../../read-models');
const { P } = require('../../security/permissionCatalog');
const { DEFINITIONS } = require('./crm.definitions');
const { loadCrmRows } = require('./crm.rows');
const { INPUTS, PARAMS, SNAPSHOT_KEY } = require('./crm.inputs');
const { filtersOf } = require('./crm.filters');
require('../sourceSpecs.crm');

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

/** Devolve [{ code, result, inputs }] (um por KPI publicado na empresa). Nenhum read model alimentado ainda: o KPI sai sem instante de fonte (INCOMPLETE na leitura). */
async function buildCrmKpiEntries(scope, asOfDate, transaction) {
  const rows = await loadCrmRows(scope, asOfDate, transaction);
  const settings = await readCrmKpiParams(scope, transaction);
  const filters = filtersOf(asOfDate, (await readComercialParams(scope, transaction)).nextActionIncludesToday);
  const sourceCtx = { groupId: scope.groupId, companyId: scope.companyId, permissions: [P.READ] };
  const catalog = getFormulaCatalog();
  const out = [];
  for (const def of DEFINITIONS) {
    const published = await publishedVersion(def.metricCode, scope.companyId, transaction);
    if (!published) continue;
    const inputs = INPUTS[def.metricCode](rows);
    const params = PARAMS[def.metricCode](settings);
    const result = catalog.get(def.metricCode).compute(inputs, params);
    const { sourceRefs } = await buildSourceRefs(sourceCtx, def.metricCode, { filter: filters.byCode[def.metricCode], unit: published.unit }, transaction);
    const base = {
      metricId: published.metricId, metricVersionId: published.metricVersionId, groupId: scope.groupId, companyId: scope.companyId, scopeType: 'COMPANY', scopeId: scope.companyId,
      periodStart: filters.periodStart, periodEnd: asOfDate, asOfDate, status: result.status, sourceSnapshotAt: rows.snapshotAt[SNAPSHOT_KEY[def.metricCode]], readModelVersion: getReadModel(def.sourceReadModel).version,
      sourceRefs, calcHash: calcHash({ metricCode: def.metricCode, version: published.version, inputs, params }),
    };
    out.push({ code: def.metricCode, result, inputs: snapshotInputs(base, result) });
  }
  return out;
}

module.exports = { buildCrmKpiEntries };
