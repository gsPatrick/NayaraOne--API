'use strict';

const errors = require('../ingest.errors');

/**
 * Registro dos destinos por entidade. Uma entidade nova entra com um arquivo `<entidade>.target.js` (assess, upsert, markDeleted) e uma linha aqui; a semente da fonte
 * (seeds) só declara entidade que tem destino.
 */
const targets = {
  PERSON: require('./person.target'),
  SUPPLIER: require('./supplier.target'),
  PROPERTY: require('./property.target'),
};

function getTarget(entity) {
  const target = targets[entity];
  if (!target) throw errors.targetMissing(entity);
  return target;
}

/** Só testes: troca/instala um destino (por exemplo, um que falha na linha N). Devolve a função de restauração. */
function overrideTarget(entity, target) {
  const previous = targets[entity];
  targets[entity] = target;
  return () => { if (previous) targets[entity] = previous; else delete targets[entity]; };
}

module.exports = { getTarget, overrideTarget, ENTITIES: () => Object.keys(targets) };
