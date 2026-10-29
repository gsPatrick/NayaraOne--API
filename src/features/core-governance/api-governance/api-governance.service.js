'use strict';

/**
 * Governança de API — serviço do módulo. Consumidores e deprecações (M9-D841) em `consumers/`; contrato OpenAPI (M9-D840) em `openapi/`; padrões de API (M9-D843) em `standards/`.
 */
const consumers = require('./consumers');

module.exports = {
  listConsumers: consumers.listConsumers,
  registerConsumer: consumers.registerConsumer,
  createDeprecation: consumers.createDeprecation,
  cancelDeprecation: consumers.cancelDeprecation,
  listDeprecations: consumers.listDeprecations,
};
