'use strict';

/**
 * M9-D605 (3.1) — detecção de fórmula não determinística. Executa os casos de teste da fórmula várias vezes com relógio e sorteio
 * bloqueados (Date.now, new Date() sem argumento, Math.random) e entradas clonadas; resultado diferente entre execuções, uso de
 * relógio/sorteio ou mutação da entrada dá 500 ANALYTICS_FORMULA_NOT_DETERMINISTIC. É a checagem em tempo de execução; a estática é a
 * regra de lint `nayara/no-float-money` na pasta formulas/.
 */
const { canonical } = require('./formulaCatalog');
const { notDeterministic } = require('./formulaErrors');

const RUNS = 3;

class ClockViolation extends Error {}

function withClockAndRandomBlocked(fn) {
  const RealDate = Date;
  const realRandom = Math.random;
  class GuardedDate extends RealDate {
    constructor(...args) {
      if (!args.length) throw new ClockViolation('relógio');
      super(...args);
    }

    static now() { throw new ClockViolation('relógio'); }
  }
  global.Date = GuardedDate;
  Math.random = () => { throw new ClockViolation('sorteio'); };
  try {
    return fn();
  } finally {
    global.Date = RealDate;
    Math.random = realRandom;
  }
}

function assertDeterministicFormula(formula, runs = RUNS) {
  const cases = Array.isArray(formula.testCases) ? formula.testCases : [];
  for (const c of cases) {
    const seen = new Set();
    for (let i = 0; i < runs; i += 1) {
      const input = structuredClone(c.input);
      let result;
      try {
        result = withClockAndRandomBlocked(() => formula.compute(input, structuredClone(c.params || {})));
      } catch (err) {
        if (err instanceof ClockViolation) throw notDeterministic(`usa ${err.message}`);
        throw err;
      }
      if (canonical(input) !== canonical(c.input)) throw notDeterministic('altera a própria entrada');
      seen.add(canonical(result));
    }
    if (seen.size > 1) throw notDeterministic('resultados diferentes para a mesma entrada');
  }
}

module.exports = { assertDeterministicFormula };
