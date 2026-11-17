'use strict';

/**
 * M9-D611 (4) — abertura do detalhe de um número a partir do `sourceRefs`: confere o hash e a assinatura do filtro (400
 * ANALYTICS_FILTER_HASH_INVALID se adulterado) e a permissão (403 ANALYTICS_DRILLDOWN_FORBIDDEN). Devolve a contagem e os ids pedidos
 * (a rota e o mascaramento das linhas são da M9-D690/M9-D700; este serviço é a única porta para o filtro assinado).
 */
const { getSourceSpec } = require('./sourceRefs.spec');
const { verifyFilter } = require('./sourceRefs.filter');
const { countRows, sampleIds } = require('./sourceRefs.query');
const { metricContext, detailAllowed } = require('./sourceRefs.build');
const { drilldownForbidden, sourceSpecMissing } = require('./sourceRefs.errors');

/**
 * `rows: false` (detalhe paginado da M9-D690, que conta e lista as linhas por conta própria): só confere filtro e permissão e devolve a descrição,
 * sem contar nem amostrar a origem (antes eram duas varreduras a mais por abertura do detalhe, achado da carga em escala cheia, M9-D699).
 */
async function openSourceDetail(ctx, metricCode, ref, transaction, { limit = 100, domain, rows = true } = {}) {
  const spec = getSourceSpec(metricCode);
  if (!spec || spec.components) throw sourceSpecMissing(metricCode);
  const filter = await verifyFilter(ctx.companyId, spec.table, ref);
  const context = await metricContext(metricCode, { domain }, transaction);
  if (!(await detailAllowed(ctx, context.domain, transaction))) throw drilldownForbidden();
  if (!rows) return { type: spec.type, table: spec.table, count: null, ids: [], description: spec.describe(filter) };
  return { type: spec.type, table: spec.table, count: await countRows(spec, filter, transaction), ids: await sampleIds(spec, filter, Math.min(limit, 1000), transaction), description: spec.describe(filter) };
}

module.exports = { openSourceDetail };
