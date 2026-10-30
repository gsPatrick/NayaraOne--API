'use strict';

/**
 * M9-D632 / M9-D633 — monta, para uma empresa e data-base, o resultado de cada KPI de Comercial e Imóveis e as entradas de snapshot (principal +
 * dimensões) a partir dos read models. Serve ao cálculo normal (commercial.materialize) e ao snapshot diário (commercial.snapshotProvider, M9-D609). A
 * fonte é sempre o estado atual do read model: os KPIs de fluxo (visitas, propostas, preços, Radar, corretores) valem para qualquer data-base do mês
 * guardado por dia; os de posição (imóveis) só para hoje, porque a carteira não guarda histórico (data passada não é inventada: lista vazia).
 */
const { sequelize } = require('../../../../models');
const { getFormulaCatalog } = require('../formulaCatalog');
const { calcHash } = require('../calcHash');
const { runFormula } = require('../formulaRun');
const clock = require('../clock');
const { buildSourceRefs } = require('../sourceRefs.build');
const { getReadModel } = require('../../read-models');
const { P } = require('../../security/permissionCatalog');
const { PACKS } = require('./commercial.packs');
const { windowOf } = require('./commercial.window');

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

/** Entradas de um pacote: só os KPIs pedidos e, em data passada, só os de fluxo. */
async function buildPackEntries(pack, scope, asOfDate, transaction, { only, isToday, window, sourceCtx, catalog }) {
  const defs = pack.definitions.filter((d) => (!only || only.includes(d.metricCode)) && (isToday || !pack.positionCodes.includes(d.metricCode)));
  if (!defs.length) return [];
  const rows = await pack.loadRows(scope, asOfDate, transaction);
  const context = await pack.context(scope, transaction);
  const filters = pack.filters(window);
  const out = [];
  for (const def of defs) {
    const published = await publishedVersion(def.metricCode, scope.companyId, transaction);
    if (!published) continue;
    const inputs = pack.inputs[def.metricCode](rows, context);
    const params = pack.params[def.metricCode](context);
    const result = runFormula(catalog.get(def.metricCode), inputs, params);
    const { sourceRefs } = await buildSourceRefs(sourceCtx, def.metricCode, { filter: filters[def.metricCode], unit: published.unit }, transaction);
    const base = {
      metricId: published.metricId, metricVersionId: published.metricVersionId, groupId: scope.groupId, companyId: scope.companyId, scopeType: 'COMPANY', scopeId: scope.companyId,
      periodStart: pack.positionCodes.includes(def.metricCode) ? asOfDate : window.periodStart, periodEnd: asOfDate, asOfDate, status: result.status,
      sourceSnapshotAt: rows.snapshotAt[pack.snapshotKey[def.metricCode]], readModelVersion: getReadModel(def.sourceReadModel).version,
      sourceRefs, calcHash: calcHash({ metricCode: def.metricCode, version: published.version, inputs, params }),
    };
    out.push({ code: def.metricCode, result, inputs: snapshotInputs(base, result) });
  }
  return out;
}

/** Devolve [{ code, result, inputs }] (um por KPI publicado na empresa); `only` limita aos códigos informados. */
async function buildCommercialKpiEntries(scope, asOfDate, transaction, only = null) {
  const shared = {
    only, isToday: asOfDate === clock.businessToday(), window: windowOf(asOfDate), catalog: getFormulaCatalog(),
    sourceCtx: { groupId: scope.groupId, companyId: scope.companyId, permissions: [P.READ] },
  };
  const out = [];
  for (const pack of PACKS) out.push(...await buildPackEntries(pack, scope, asOfDate, transaction, shared));
  return out;
}

module.exports = { buildCommercialKpiEntries, snapshotInputs };
