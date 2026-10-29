'use strict';

// M9-D650 / M9-D690 (3.3) — campos e tela do registro no detalhe dos KPIs de avanço, custo e margem das obras. A tela da obra abre pelo id da obra (forecast e
// margem, uma linha por obra); as etapas do progresso mostram a obra na linha, sem link próprio de tela.
const { registerDrilldownDetail } = require('./drilldown.details');

const COST = { columns: ['budget_cost', 'actual_cost', 'forecast_cost', 'contract_revenue', 'projected_margin'], link: '/painel/obras/lista/{id}' };
registerDrilldownDetail('obra.baseline_actual_forecast', COST);
registerDrilldownDetail('obra.projected_margin', COST);
registerDrilldownDetail('obra.progress_vs_schedule', { columns: ['project_id', 'planned_pct', 'measured_pct', 'planned_cost'] });
