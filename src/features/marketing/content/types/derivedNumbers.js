'use strict';

const { reductionPercent, currentPriceOf } = require('./priceReduction');

/**
 * M9-D409 — números que o texto pode citar porque SAEM DOS FATOS por conta exata: o percentual da redução de preço (anterior e
 * atual do cadastro). Devolve o conjunto de textos aceitos ("2,50" e as formas com 0 a 4 casas, pois o número de casas é
 * parâmetro da empresa). Serve ao validador factual: um percentual que o servidor calcula dos fatos não é número inventado.
 */
function derivedNumbersFromFacts(facts) {
  const out = new Set();
  if (!facts || typeof facts !== 'object') return out;
  for (let decimals = 0; decimals <= 4; decimals += 1) {
    const result = reductionPercent(facts.precoAnterior, currentPriceOf(facts), decimals);
    if (result.isReduction) out.add(result.percent);
  }
  return out;
}

module.exports = { derivedNumbersFromFacts };
