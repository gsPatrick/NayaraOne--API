'use strict';

const { createAnalyticsRouter, router } = require('./routes');
const readOnly = require('./readOnly');

/**
 * src/features/analytics — camada de leitura gerencial do Marco 9 (BI e Centro de Comando). Esta entrada exporta o router de
 * /v1/analytics/* e a garantia de somente leitura (M9-D612). As 7 subpastas (camadas) da M9-D613 têm index.js e README próprios.
 */
const CAMADAS = ['metrics', 'read-models', 'dashboards', 'alerts', 'quality', 'exports', 'briefs'];

module.exports = { router, createAnalyticsRouter, camadas: CAMADAS, ...readOnly };
