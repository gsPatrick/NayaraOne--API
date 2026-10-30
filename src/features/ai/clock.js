'use strict';

/**
 * Relógio injetável da NAY (DI-IA-LEVE-1), no mesmo formato do relógio do BI (analytics/metrics/clock). Os serviços de ferramenta, o
 * cache e os leitores dos agentes pedem "agora" daqui e nunca de `new Date()` direto; o teste fixa o instante com `setClock`.
 */
let provider = null;

/** Instante atual (ou o fixado por `setClock`). */
function now() {
  return provider ? new Date(provider()) : new Date();
}

/** Só para teste: fixa o relógio. `fn` devolve a Date (ou ISO) de "agora". */
function setClock(fn) {
  provider = typeof fn === 'function' ? fn : () => fn;
}

function resetClock() {
  provider = null;
}

module.exports = { now, setClock, resetClock };
