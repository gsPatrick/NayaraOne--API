'use strict';

// Medição de tempo dos testes de desempenho (DI-M9F-4): o que se mede é a OPERAÇÃO, com aquecimento e mediana de várias execuções, para a carga da máquina
// (outras baterias rodando ao mesmo tempo) não decidir o resultado. O limite de cada teste não muda: só a forma de medir. Não é teste.

/** Tempo de CPU (usuário + sistema) do processo gasto pela função SÍNCRONA, em ms: o trabalho da operação, sem o tempo esperando a CPU numa máquina carregada. */
function cpuMs(fn) {
  const before = process.cpuUsage();
  fn();
  const spent = process.cpuUsage(before);
  return (spent.user + spent.system) / 1000;
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * Mediana do tempo de CPU de `vezes` execuções (ímpar), depois de `aquecimento` execuções descartadas (compilação do JIT, primeira alocação). Com `limite`, para assim que a
 * mediana fica decidida (a maioria das execuções já ficou abaixo, ou acima, do limite): o resultado é o mesmo da mediana completa, com menos execuções.
 */
function medianCpuMs(fn, { vezes = 3, aquecimento = 1, limite = null } = {}) {
  for (let i = 0; i < aquecimento; i += 1) fn();
  const runs = [];
  const majority = Math.floor(vezes / 2) + 1;
  for (let i = 0; i < vezes; i += 1) {
    runs.push(cpuMs(fn));
    if (limite === null) continue;
    const below = runs.filter((ms) => ms < limite);
    const above = runs.filter((ms) => ms >= limite);
    // decidida: a mediana completa fica entre os valores da maioria, então o maior dos de baixo (ou o menor dos de cima) a limita
    if (below.length >= majority) return Math.max(...below);
    if (above.length >= majority) return Math.min(...above);
  }
  return median(runs);
}

const p95Of = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

/**
 * p95 robusto de uma operação assíncrona: `aquecimento` chamadas descartadas, `series` séries de `porSerie` chamadas, o p95 de cada série e a MEDIANA desses p95.
 * `operacao()` devolve o tempo da operação em ms (ex.: o tempo do pedido medido no servidor, sem o cliente HTTP). Devolve { p95, series }.
 */
async function robustP95(operacao, { aquecimento = 5, series = 3, porSerie = 20 } = {}) {
  for (let i = 0; i < aquecimento; i += 1) await operacao();
  const p95s = [];
  for (let s = 0; s < series; s += 1) {
    const times = [];
    for (let i = 0; i < porSerie; i += 1) times.push(await operacao());
    p95s.push(p95Of(times));
  }
  return { p95: median(p95s), series: p95s };
}

module.exports = { cpuMs, medianCpuMs, robustP95, median, p95Of };
