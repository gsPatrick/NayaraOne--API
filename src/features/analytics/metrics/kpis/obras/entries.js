'use strict';

/**
 * M9-D650 / M9-D651 — monta, para uma empresa e a data de hoje, o resultado de cada KPI de Obras e as entradas de snapshot (principal + dimensões)
 * a partir dos read models da M9-D618. Cálculo só no backend, pela fórmula versionada do catálogo (M9-D603); valor, status, hash do cálculo e
 * sourceRefs (M9-D611) ficam no snapshot. KPI sem base no read model (nenhuma obra) não gera entrada: nada é inventado.
 */
const { getFormulaCatalog } = require('../../formulaCatalog');
const { runFormula } = require('../../formulaRun');
const { calcHash } = require('../../calcHash');
const { buildSourceRefs } = require('../../sourceRefs.build');
const { P } = require('../../../security/permissionCatalog');
const { KPI_DEFINITIONS } = require('./definitions');
const { loadObraInput } = require('./inputs');
const { sourceFilter } = require('./filters');
const { publishedVersion, snapshotInputs } = require('./snapshotInputs');
require('../../sourceSpecs.obras.custo'); // M9-D650
require('../../sourceSpecs.obras.operacao'); // M9-D651

/** Devolve [{ code, result, inputs }] (um por KPI publicado com base no read model). */
async function buildObraKpiEntries(scope, asOfDate, transaction) {
  const sourceCtx = { groupId: scope.groupId, companyId: scope.companyId, permissions: [P.READ] };
  const catalog = getFormulaCatalog();
  const out = [];
  for (const def of KPI_DEFINITIONS) {
    const published = await publishedVersion(def.metricCode, scope.companyId, transaction);
    if (!published) continue;
    const loaded = await loadObraInput(def.metricCode, scope, asOfDate, transaction);
    if (!loaded) continue;
    const result = runFormula(catalog.get(def.formulaId), loaded.input, loaded.params);
    const { sourceRefs } = await buildSourceRefs(sourceCtx, def.metricCode, { filter: sourceFilter(def.metricCode, asOfDate), unit: published.unit }, transaction);
    const base = {
      metricId: published.metricId, metricVersionId: published.metricVersionId, groupId: scope.groupId, companyId: scope.companyId, scopeType: 'COMPANY', scopeId: scope.companyId,
      periodStart: asOfDate, periodEnd: asOfDate, asOfDate, status: result.status, sourceSnapshotAt: loaded.source.snapshotAt, readModelVersion: loaded.source.version,
      sourceRefs, calcHash: calcHash({ metricCode: def.metricCode, version: published.version, inputs: loaded.input, params: loaded.params }),
    };
    out.push({ code: def.metricCode, result, inputs: snapshotInputs(base, result) });
  }
  return out;
}

module.exports = { buildObraKpiEntries };
