'use strict';

/**
 * M9-D650 / M9-D611 — origem dos números dos KPIs de avanço, custo e margem das obras: quais registros reproduzem cada um. O progresso sai das etapas
 * (project_stages). O forecast e a margem projetada não existem no OLTP (são projeção): a origem é a linha da obra no read model rm_project_cost, que guarda
 * a projeção pronta, e o detalhe soma essa coluna. O filtro é montado e assinado por kpis/obras/entries (filters.custo.js).
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { MODELS } = require('./kpis/obras/models');

const LIVE = { deletedAt: 'deleted_at' };
const COST = { type: 'PROJECT_COST', table: `analytics.${MODELS.cost}`, idColumn: 'project_id' }; // schema montado pelo nome: a varredura R1 (M9-D700) só deixa citar rm_ na camada read-models

const SPECS = [
  {
    type: 'PROJECT_STAGES', table: 'construction.project_stages', metricCode: 'obra.progress_vs_schedule', columns: { equals: LIVE },
    describe: () => 'Etapas das obras (não excluídas) com o percentual planejado e o medido que compõem o avanço, ponderados pelo custo planejado da etapa',
  },
  { ...COST, metricCode: 'obra.baseline_actual_forecast', valueColumn: 'forecast_cost', describe: () => 'Projeção do custo final de cada obra (forecast = real + custo a fazer pelo desvio já observado), uma linha por obra' },
  { ...COST, metricCode: 'obra.projected_margin', valueColumn: 'projected_margin', describe: () => 'Margem projetada de cada obra (receita contratada menos o forecast do custo), uma linha por obra' },
];

for (const spec of SPECS) if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);

module.exports = { OBRA_COST_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
