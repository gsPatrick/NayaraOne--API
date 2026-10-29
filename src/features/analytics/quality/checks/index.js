'use strict';

// M9-D696 (3.3) — catálogo de checks: um arquivo <read-model>.checks.js por read model. O CI falha se um read model não declarar (M9-D705).
require('./rm_finance_health.checks');
require('./rm_finance_sector_margin.checks');
require('./rm_finance_intercompany.checks'); // M9-D625
// M9-D696: os read models de domínio (Comercial, Imóveis, Locação, Obras, Estoque, Jurídico, Correspondente, Marketing, Atendimento)
require('./rm_crm_lead_daily.checks');
require('./rm_crm_opportunity_stage.checks');
require('./rm_crm_outcome.checks');
require('./rm_crm_next_action.checks');
require('./rm_crm_visits_proposals.checks');
require('./rm_property_portfolio.checks');
require('./rm_property_price_changes.checks');
require('./rm_radar_matches.checks');
require('./rm_broker_performance.checks');
require('./rm_rental_contracts.checks');
require('./rm_rental_vacancy.checks');
require('./rm_rental_arrears.checks');
require('./rm_rental_guarantees.checks');
require('./rm_rental_obligations.checks');
require('./rm_rental_inspections_keys.checks');
require('./rm_rental_tickets.checks');
require('./rm_rental_satisfaction.checks');
require('./rm_rental_repasses.checks');
require('./rm_project_progress.checks');
require('./rm_project_cost.checks');
require('./rm_project_delays.checks');
require('./rm_project_measurements.checks');
require('./rm_project_nonconformities.checks');
require('./rm_project_waste.checks');
require('./rm_postwork_cost.checks');
require('./rm_inventory_health.checks');
require('./rm_tool_assets.checks');
require('./rm_legal_deadlines.checks');
require('./rm_legal_cases_risk.checks');
require('./rm_legal_values.checks');
require('./rm_legal_missing_docs.checks');
require('./rm_fin_cases_stage.checks');
require('./rm_fin_provider_outcome.checks');
require('./rm_fin_commission.checks');
require('./rm_mkt_campaigns.checks');
require('./rm_mkt_delivery.checks');
require('./rm_mkt_frequency.checks');
require('./rm_mkt_reviews.checks');
require('./rm_mkt_automation.checks');
require('./rm_support_satisfaction.checks');
require('./rm_support_complaints.checks');
require('./rm_support_sla.checks');
