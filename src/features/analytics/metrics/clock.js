'use strict';

/**
 * M9-D606 (3.2 regra 5) — relógio único do BI. Todo código de análise obtém "agora" daqui (`clock.now()`), nunca de `new Date()` direto,
 * para o teste fixar o tempo. "Hoje" é sempre a data de calendário de São Paulo (`businessToday`). Este é o único arquivo do BI que
 * lê o relógio do servidor; o teste m9d606 reprova qualquer outro.
 */
const { businessDateKey } = require('../../../utils/businessDate');

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

/** Data de calendário (AAAA-MM-DD) de São Paulo no instante dado (padrão: agora). */
function businessToday(instant) {
  return businessDateKey(instant === undefined ? now() : instant);
}

module.exports = { now, setClock, resetClock, businessToday };
