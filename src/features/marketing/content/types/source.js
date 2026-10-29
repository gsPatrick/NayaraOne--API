'use strict';

const { buildFactsFromReadModel } = require('../step.facts');
const { SOURCE_ENTITY_OF_LOADER } = require('./definitions');

/**
 * M9-D409 — carregador de fonte do tipo (sourceLoader da definição). Só carrega quando a fonte informada é do tipo certo; fonte
 * ausente ou de outro tipo devolve null e o validador acusa o campo faltante. Lê SOMENTE os read models públicos (M9-D403).
 */
async function loadTypeSource(def, input, tenant, transaction) {
  const expected = SOURCE_ENTITY_OF_LOADER[def.sourceLoader];
  if (!expected || input.sourceEntityType !== expected || !input.sourceEntityId) return null;
  const source = await buildFactsFromReadModel(expected, input.sourceEntityId, tenant, transaction, def.type);
  return { entityType: expected, entityId: input.sourceEntityId, ...source };
}

module.exports = { loadTypeSource };
