'use strict';

/**
 * M9-D619 — read models de Jurídico e Correspondente Bancário do BI (schema analytics). Cada read model tem o seu arquivo (uma responsabilidade por
 * arquivo); este reúne o registro dos sete:
 *   jurídico        rm_legal_deadlines, rm_legal_cases_risk, rm_legal_values, rm_legal_missing_docs
 *   correspondente  rm_fin_cases_stage, rm_fin_provider_outcome, rm_fin_commission
 * Somente os serviços de métrica de analytics/metrics leem estas tabelas (M9-D613); painéis e briefs leem a métrica.
 */
const models = [
  require('./juridico-legal-deadlines.readmodel'),
  require('./juridico-legal-cases-risk.readmodel'),
  require('./juridico-legal-values.readmodel'),
  require('./juridico-legal-missing-docs.readmodel'),
  require('./correspondente-fin-cases-stage.readmodel'),
  require('./correspondente-fin-provider-outcome.readmodel'),
  require('./correspondente-fin-commission.readmodel'),
];

module.exports = { JURIDICO_CORRESPONDENTE_MODELS: models.map((m) => m.def.name) };
