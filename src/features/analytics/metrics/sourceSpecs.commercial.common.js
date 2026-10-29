'use strict';

/**
 * M9-D632 / M9-D633 / M9-D611 — peças comuns das especificações de origem dos KPIs de Comercial e Imóveis: texto do período, condição fixa em SQL do
 * código (`predicates`), registro excluído fora e o registro (idempotente) da origem e do detalhe de cada KPI.
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const span = (f) => `${f.period && f.period.from ? `de ${day(f.period.from)} ` : ''}antes de ${f.period ? day(f.period.to) : 'hoje'}`;
const fixed = (sql) => () => ({ sql, replacements: {} });
const LIVE = { deletedAt: 'deleted_at' };
const PROPERTIES = { type: 'PROPERTIES', table: 'real_estate.properties' };

/** Registra a origem e o detalhe (colunas e tela do registro) de cada KPI; `details` é { código: { columns, link } }. */
function registerAll(specs, details) {
  for (const spec of specs) {
    if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
    registerDrilldownDetail(spec.metricCode, details[spec.metricCode]);
  }
  return specs.map((s) => s.metricCode);
}

module.exports = { day, span, fixed, LIVE, PROPERTIES, registerAll };
