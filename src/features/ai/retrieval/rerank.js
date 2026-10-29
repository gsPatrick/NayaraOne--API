'use strict';

const { CLASSIFICATION_RANK } = require('./retrieval.constants');

const SCORE_DECIMALS = 5;
const round = (n) => Number(Number(n).toFixed(SCORE_DECIMALS));

/**
 * Rerank determinístico (M9-D023, passo 3). Ordem total, sem pesos: (1) relevância (a maior entre a similaridade de cosseno e a do texto),
 * arredondada a 5 casas como é gravada em ai_sources; (2) versão da fonte mais recente; (3) classificação menos sensível; (4) id do
 * chunk. Mesmas entradas dão sempre a mesma lista, qualquer que seja a ordem em que o banco devolveu os candidatos.
 */
function rerank(candidates) {
  return [...candidates].sort((a, b) => round(b.relevance) - round(a.relevance)
    || b.sourceVersion - a.sourceVersion
    || (CLASSIFICATION_RANK[a.classification] ?? 3) - (CLASSIFICATION_RANK[b.classification] ?? 3)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const score = (relevance) => Math.min(1, Math.max(0, round(relevance)));

module.exports = { rerank, score };
