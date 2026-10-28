'use strict';

const { mktNotImplemented } = require('../marketing.errors');

/**
 * Marketing / publications — serviço da área. A fundação (M9-D402) entrega a casa e as portas de permissão; as regras de negócio entram
 * nas demandas dona de cada rota (M9-D435 lista as rotas e as demandas que as preenchem), sobre este mesmo arquivo.
 */
function pendingOwner(owner) {
  throw mktNotImplemented(owner);
}

module.exports = { pendingOwner };
