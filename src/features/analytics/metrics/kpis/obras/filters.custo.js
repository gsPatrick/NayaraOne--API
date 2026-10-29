'use strict';

// M9-D650 — filtro de origem (sourceRefs) dos KPIs de avanço, custo e margem: o estado de hoje da tabela de origem (condições fixas em sourceSpecs.obras.custo).
const FILTERS = Object.freeze({
  'obra.progress_vs_schedule': () => ({ equals: { deletedAt: null } }),
  'obra.baseline_actual_forecast': () => ({}),
  'obra.projected_margin': () => ({}),
});

module.exports = { FILTERS };
