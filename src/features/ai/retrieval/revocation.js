'use strict';

const chunks = require('./chunks.repository');
const V = require('./ingestion.input');
const E = require('./retrieval.errors');
const { SOURCE_KINDS } = require('./retrieval.constants');

/**
 * Revogar uma origem (conhecimento, arquivo, link ou contrato substituído) marca TODOS os seus chunks ACTIVE como REVOKED (M9-D024). Quem
 * revoga a origem chama isto dentro da MESMA transação: ou a origem e os chunks mudam juntos, ou nenhum dos dois. Uma busca concorrente
 * vê o estado de antes ou o de depois, nunca meio a meio. Devolve quantos chunks saíram da busca.
 */
async function revokeSource(ctx, sourceType, sourceId, transaction) {
  V.ctxOk(ctx);
  if (!SOURCE_KINDS.includes(sourceType) || !sourceId) throw E.searchInvalid('Informe a origem a revogar.');
  return chunks.retractSource(ctx, sourceType, sourceId, 'REVOKED', transaction);
}

module.exports = { revokeSource };
