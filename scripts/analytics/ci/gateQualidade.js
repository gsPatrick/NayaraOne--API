#!/usr/bin/env node
'use strict';

/** M9-D705 etapa 8 — todo read model registrado declara os checks mínimos de qualidade (freshness, reconciliação, invariante, completude). */
const readModels = require('../../../src/features/analytics/read-models');
const quality = require('../../../src/features/analytics/quality');
const { avaliarChecksPorReadModel } = require('./gates/qualidade');

const modelos = readModels.listReadModels();
const r = avaliarChecksPorReadModel(modelos, quality);
if (!r.ok) {
  r.problemas.forEach((p) => console.error(`Read model sem checks: ${p}`));
  process.exit(1);
}
console.log(`OK: ${modelos.length} read model(s) com os checks mínimos.`);
