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

async function openSourceDetail(ctx, metricCode, ref, transaction, { limit = 100, domain } = {}) {
  const spec = getSourceSpec(metricCode);
  if (!spec || spec.components) throw sourceSpecMissing(metricCode);
  const filter = await verifyFilter(ctx.companyId, spec.table, ref);
  const context = await metricContext(metricCode, { domain }, transaction);
  if (!(await detailAllowed(ctx, context.domain, transaction))) throw drilldownForbidden();
  return { type: spec.type, table: spec.table, count: await countRows(spec, filter, transaction), ids: await sampleIds(spec, filter, Math.min(limit, 1000), transaction), description: spec.describe(filter) };
}

module.exports = { openSourceDetail };
