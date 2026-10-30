'use strict';

/**
 * M9-D699 (reabertura M-4) — ocupação da CPU da máquina durante uma janela de medição (fração de 0 a 1, 2 casas), pela diferença dos contadores de
 * os.cpus() entre o início e o fim. Máquina de núcleos todos ocupados (pelo próprio BI, pelo banco ou por outros processos) faz o p95 de operações de
 * poucos ms medir a disputa por CPU, não o BI: o veredito de latência trata isso como INCONCLUSIVO (verdict.js).
 */
const os = require('node:os');

const totals = () => os.cpus().reduce((acc, c) => {
  const t = Object.values(c.times).reduce((a, b) => a + b, 0);
  return { idle: acc.idle + c.times.idle, total: acc.total + t };
}, { idle: 0, total: 0 });

/** Devolve uma função `stop()` que entrega a fração ocupada desde a chamada. */
function startCpuMeter() {
  const from = totals();
  return function stop() {
    const to = totals();
    const total = to.total - from.total;
    return total <= 0 ? 0 : Math.round((1 - (to.idle - from.idle) / total) * 100) / 100;
  };
}

module.exports = { startCpuMeter };
