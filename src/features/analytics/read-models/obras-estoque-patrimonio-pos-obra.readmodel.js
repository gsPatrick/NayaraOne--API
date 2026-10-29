'use strict';

/**
 * M9-D618 — read models de Obras, Estoque/Patrimônio e Pós-obra do BI (schema analytics). Cada read model tem o seu arquivo (uma responsabilidade
 * por arquivo); este reúne o registro dos nove:
 *   obras         rm_project_progress, rm_project_cost, rm_project_delays, rm_project_measurements, rm_project_nonconformities, rm_project_waste
 *   pós-obra      rm_postwork_cost, rm_project_occurrences (M9-D652)
 *   estoque       rm_inventory_health, rm_tool_assets
 * Somente os serviços de métrica de analytics/metrics leem estas tabelas (M9-D613); painéis e briefs leem a métrica.
 */
const models = [
  require('./obras-project-progress.readmodel'),
  require('./obras-project-cost.readmodel'),
  require('./obras-project-delays.readmodel'),
  require('./obras-project-measurements.readmodel'),
  require('./obras-project-nonconformities.readmodel'),
  require('./obras-project-waste.readmodel'),
  require('./obras-postwork-cost.readmodel'),
  require('./obras-project-occurrences.readmodel'), // M9-D652: ocorrências para a recorrência
  require('./estoque-inventory-health.readmodel'),
  require('./estoque-tool-assets.readmodel'),
];

module.exports = { OBRAS_ESTOQUE_MODELS: models.map((m) => m.def.name) };
