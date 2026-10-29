'use strict';

/**
 * M9-D619 — read models cujo AGREGADO é a empresa inteira (`aggregateColumns: []`): várias linhas por dimensão, todas recalculadas juntas. O evento, o
 * rebuild e (quando há) a agenda apontam para a mesma chave vazia.
 */
const companyAggregateKey = () => ({});
const companyKeys = async () => [{}];

module.exports = { companyAggregateKey, companyKeys };
