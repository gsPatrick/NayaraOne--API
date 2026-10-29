'use strict';

const { createAnalyticsRouter, router } = require('./routes');
const readOnly = require('./readOnly');
const readModels = require('./read-models'); // liga o worker de eventos dos read models ao outbox (M9-D607)
require('./quality'); // liga os checks de qualidade ao fim de cada refresh e ao rebuild (M9-D696)
require('./metrics/kpis').installFinanceKpis(); // liga os KPIs financeiros (conciliações e anomalias) ao fim do refresh do rm_finance_health (M9-D624)
require('./metrics/kpis/commercial').installCommercialKpis(); // liga os KPIs de visitas, propostas, imóveis, Radar e corretores ao fim do refresh dos read models de origem (M9-D632 e M9-D633)
require('./metrics/kpis').installObraKpis(); // liga os KPIs de Obras ao fim do refresh dos read models de Obras (M9-D650 e M9-D651)
require('./metrics/kpis').installCrmKpis(); // liga os KPIs do funil comercial ao fim do refresh dos read models do CRM (M9-D630 e M9-D631)
require('./metrics/kpis').installLegalCorKpis(); // liga os KPIs do Jurídico e do Correspondente ao fim do refresh dos seus read models (M9-D660 e M9-D661)
require('./metrics/kpis').installMarketingKpis(); // liga os KPIs de Marketing ao fim do refresh dos seus read models (M9-D670 e M9-D671)
require('./metrics/kpis').installSupportKpis(); // liga os KPIs de Atendimento ao fim do refresh dos seus read models (M9-D672)
require('./metrics/kpis').installRentalDeadlineKpis(); // liga os KPIs de prazos da Locação ao fim do refresh dos seus read models (M9-D641)
require('./metrics/kpis').installRentalCareKpis(); // liga os KPIs de chamados, satisfação e repasses da Locação ao fim do refresh dos seus read models (M9-D642)
require('./metrics/kpis').installRentalPortfolioKpis(); // liga os KPIs de contratos ativos, vacância e inadimplência da Locação ao fim do refresh dos seus read models (M9-D640)
require('./metrics/kpis').installCommandEventKpis(); // liga os KPIs de fatos do dia do Centro de Comando ao fim do refresh de rm_command_events (M9-D710)
require('./metrics/kpis').installTechKpis(); // liga os KPIs de Tecnologia ao fim do refresh dos seus read models (M9-D680)
require('./metrics/kpis').installIaKpis(); // liga os KPIs de IA (custo, qualidade, orçamento e chamadas bloqueadas) ao fim do refresh dos seus read models (M9-D681)
require('./metrics/kpis').installDecisionQueueKpis(); // liga os KPIs da fila de decisão ao fim do refresh de rm_decision_queue (M9-D709)
require('./metrics/kpis').installEstoqueKpis(); // liga os KPIs de Estoque e Patrimônio ao fim do refresh de rm_inventory_health e rm_tool_assets (M9-D653)
require('./metrics/kpis').installObraPerdasKpis(); // liga os KPIs de desperdício, custo pós-obra e recorrência ao fim do refresh dos read models de Obras (M9-D652)

/**
 * src/features/analytics — camada de leitura gerencial do Marco 9 (BI e Centro de Comando). Esta entrada exporta o router de
 * /v1/analytics/* e a garantia de somente leitura (M9-D612). As 7 subpastas (camadas) da M9-D613 têm index.js e README próprios.
 */
const CAMADAS = ['metrics', 'read-models', 'dashboards', 'alerts', 'quality', 'exports', 'briefs'];

module.exports = { router, createAnalyticsRouter, camadas: CAMADAS, readModels, ...readOnly };
