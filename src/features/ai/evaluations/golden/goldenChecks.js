'use strict';

/**
 * Conferências extras de um caso do golden dataset sobre a última chamada ao modelo (`env.last`): trechos obrigatórios
 * (`expected.contains`), ferramentas pedidas na ordem esperada (`expected.tools`) e o que não pode aparecer (`must_not`). O
 * resultado do avaliador da categoria só é rebaixado, nunca melhorado: uma falha aqui tira a unidade do caso.
 */
const norm = (t) => String(t || '').toLowerCase();

function goldenFailures(caseDef, last) {
  const g = caseDef.golden;
  if (!g || !last) return [];
  const text = norm(last.answer !== undefined ? last.answer : last.text);
  const failures = [];
  for (const need of g.expected.contains || []) if (!text.includes(norm(need))) failures.push(`falta: ${need}`);
  for (const banned of g.mustNot || []) if (text.includes(norm(banned))) failures.push(`proibido: ${banned}`);
  if (Array.isArray(g.expected.tools)) {
    const asked = (last.toolRequests || []).map((t) => t.name);
    if (asked.length !== g.expected.tools.length || asked.some((n, i) => n !== g.expected.tools[i])) failures.push(`ferramentas fora da ordem esperada: ${asked.join(',') || 'nenhuma'}`);
  }
  return failures;
}

/** Aplica as conferências ao item já montado pelo avaliador da categoria. */
function applyGoldenChecks(item, caseDef, last) {
  const failures = goldenFailures(caseDef, last);
  if (!failures.length) return item;
  return {
    ...item, passed: false, score: 0, okUnits: Math.max(0, Math.min(item.okUnits, item.units - 1)), details: { ...item.details, goldenFailures: failures },
  };
}

module.exports = { applyGoldenChecks, goldenFailures };
