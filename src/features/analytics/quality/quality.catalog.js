'use strict';

/**
 * M9-D696 (3.3) — catálogo de checks por read model. Cada read model declara os seus em `quality/checks/<read-model>.checks.js`
 * (carregados por checks/index.js) com `registerChecks(nome, [check...])`. Mínimo do livro por read model: freshness + reconciliação +
 * 1 invariante + completude de campos usados nas fórmulas; `assertEveryReadModelDeclaresChecks` reprova o que faltar (o CI chama).
 */
const registry = new Map();

const MINIMUM = Object.freeze([
  { label: 'freshness', types: ['FRESHNESS'] },
  { label: 'reconciliação', types: ['RECONCILIATION'] },
  { label: 'invariante', types: ['INVARIANT', 'CONSISTENCY'] },
  { label: 'completude', types: ['COMPLETENESS'] },
]);

function registerChecks(readModel, checks) {
  if (typeof readModel !== 'string' || !/^rm_[a-z][a-z0-9_]*$/.test(readModel)) throw new Error('Checks: o read model deve seguir rm_nome_em_snake.');
  if (registry.has(readModel)) throw new Error(`Checks duplicados para ${readModel}.`);
  const codes = new Set();
  for (const c of checks) {
    if (!c || typeof c.code !== 'string' || !/^[a-z][a-z0-9_]*$/.test(c.code) || typeof c.run !== 'function' || !c.type) throw new Error(`Check inválido em ${readModel}.`);
    if (codes.has(c.code)) throw new Error(`Check repetido em ${readModel}: ${c.code}.`);
    codes.add(c.code);
  }
  registry.set(readModel, Object.freeze([...checks]));
}

const unregisterChecks = (readModel) => registry.delete(readModel);
const getChecks = (readModel) => registry.get(readModel) || [];

/** Lança se algum read model não declara os checks mínimos do livro. */
function assertEveryReadModelDeclaresChecks(models) {
  const problems = [];
  for (const def of models) {
    const types = new Set(getChecks(def.name).map((c) => c.type));
    const missing = MINIMUM.filter((m) => !m.types.some((t) => types.has(t))).map((m) => m.label);
    if (missing.length) problems.push(`${def.name}: falta ${missing.join(', ')}`);
  }
  if (problems.length) throw new Error(`Todo read model precisa declarar checks (quality/checks/<read-model>.checks.js). ${problems.join('; ')}.`);
}

module.exports = { registerChecks, unregisterChecks, getChecks, assertEveryReadModelDeclaresChecks, MINIMUM };
