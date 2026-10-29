'use strict';

/**
 * M9-D650 — consultas dos KPIs de avanço, custo e margem das obras: uma linha por obra dos read models rm_project_progress e rm_project_cost
 * (M9-D618), com a origem do número (recálculo mais recente e versão do esquema). `fields` são as colunas que entram na fórmula e no hash do cálculo.
 */
const { MODELS } = require('./models');

const T = (model) => `analytics.${model}`;

const PROGRESS = {
  sql: `SELECT p.project_id::text AS id, p.baseline_percent::text AS baseline, p.actual_percent::text AS actual, c.budget_cost::text AS weight,
               p.source_snapshot_at AS "sourceSnapshotAt", p.refreshed_at AS "refreshedAt", p.version
          FROM ${T(MODELS.progress)} p LEFT JOIN ${T(MODELS.cost)} c ON c.company_id = p.company_id AND c.project_id = p.project_id
         WHERE p.company_id = :companyId ORDER BY p.project_id`,
  fields: ['id', 'baseline', 'actual', 'weight'],
  key: 'projects',
};

// forecast e margem projetada leem as mesmas linhas de custo (com o avanço medido da obra, que explica um forecast nulo)
const COST = {
  sql: `SELECT c.project_id::text AS id, c.budget_cost::text AS budget, c.actual_cost::text AS actual, c.forecast_cost::text AS forecast, c.contract_revenue::text AS revenue,
               p.actual_percent::text AS percent, c.source_snapshot_at AS "sourceSnapshotAt", c.refreshed_at AS "refreshedAt", c.version
          FROM ${T(MODELS.cost)} c LEFT JOIN ${T(MODELS.progress)} p ON p.company_id = c.company_id AND p.project_id = c.project_id
         WHERE c.company_id = :companyId ORDER BY c.project_id`,
  fields: ['id', 'budget', 'actual', 'forecast', 'revenue', 'percent'],
  key: 'projects',
};

module.exports = {
  QUERIES: Object.freeze({ 'obra.progress_vs_schedule': PROGRESS, 'obra.baseline_actual_forecast': COST, 'obra.projected_margin': COST }),
};
