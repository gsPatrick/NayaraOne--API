'use strict';

/** Métricas determinísticas do sandbox: cada nome recebe um número derivado do hash do que foi enviado (mesma entrada, mesmas métricas). */
function metricsFor(names, hash) {
  return Object.fromEntries(names.map((name, i) => [name, parseInt(hash.slice(i * 4, i * 4 + 4), 16) % 1000]));
}

module.exports = { metricsFor };
