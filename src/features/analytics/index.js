'use strict';

const { createAnalyticsRouter, router } = require('./routes');
const readOnly = require('./readOnly');
const readModels = require('./read-models'); // liga o worker de eventos dos read models ao outbox (M9-D607)
require('./quality'); // liga os checks de qualidade ao fim de cada refresh e ao rebuild (M9-D696)
require('./metrics/kpis').installFinanceKpis(); // liga os KPIs financeiros (conciliações e anomalias) ao fim do refresh do rm_finance_health (M9-D624)

/**
 * src/features/analytics — camada de leitura gerencial do Marco 9 (BI e Centro de Comando). Esta entrada exporta o router de
 * /v1/analytics/* e a garantia de somente leitura (M9-D612). As 7 subpastas (camadas) da M9-D613 têm index.js e README próprios.
 */
const CAMADAS = ['metrics', 'read-models', 'dashboards', 'alerts', 'quality', 'exports', 'briefs'];

module.exports = { router, createAnalyticsRouter, camadas: CAMADAS, readModels, ...readOnly };
