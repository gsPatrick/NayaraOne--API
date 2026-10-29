'use strict';

const baselineGrounding = require('./baseline.grounding');
const baselineTools = require('./baseline.tools');
const baselineInjection = require('./baseline.injection');

/**
 * Fontes de casos da avaliação. Cada fonte é `suite -> (agent) -> casos[]`. De fábrica vão os casos de base da engenharia (um
 * conjunto mínimo que mede as sete categorias); os golden datasets (M9-D033) e a suíte adversarial (M9-D042) entram por
 * `registerCaseSource`. Caso: { id, category, suite: GOLDEN|ADVERSARIAL, input, ...campos da categoria }.
 */
const sources = [baselineGrounding.cases, baselineTools.cases, baselineInjection.cases];

const registerCaseSource = (fn) => { sources.push(fn); return () => { const i = sources.indexOf(fn); if (i >= 0) sources.splice(i, 1); }; };

/** Casos da suíte pedida (ALL = as duas), sem repetir id. */
function loadCases(suite, agent, registry) {
  const wanted = suite === 'ALL' ? ['GOLDEN', 'ADVERSARIAL'] : [suite];
  const seen = new Set();
  const out = [];
  for (const source of sources) {
    for (const c of source(agent, registry)) {
      if (!wanted.includes(c.suite) || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

module.exports = { loadCases, registerCaseSource };
