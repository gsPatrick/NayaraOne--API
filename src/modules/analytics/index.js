'use strict';

const { createAnalyticsRouter, router } = require('./routes');
const readOnly = require('./readOnly');

/**
 * src/modules/analytics — camada de leitura gerencial do Marco 9 (BI e Centro de Comando). Esta entrada exporta o router de
 * /v1/analytics/* e a garantia de somente leitura (M9-D612). As demais subpastas chegam com M9-D613.
 */
module.exports = { router, createAnalyticsRouter, ...readOnly };
