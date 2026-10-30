'use strict';

const { THRESHOLDS } = require('../budgets/budget.constants');
const E = require('./degradation.errors');
const { assertDegradable } = require('./prod.guard');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Corpo do PUT /finops/degradation-policies: { budgetId, steps: [{ step, threshold? }], enabled? }. A ordem da lista é a ordem de aplicação. Limiar omitido
 * usa o padrão do administrador (1º passo e demais). Limiares só entre os de alerta do orçamento (50/75/90/100) e nunca decrescentes ao longo da lista.
 */
function parsePolicy(body, { firstThreshold, otherThreshold }) {
  const b = body || {};
  if (typeof b.budgetId !== 'string' || !UUID.test(b.budgetId)) throw E.policyInvalid('Informe o orçamento da política (budgetId).');
  if (!Array.isArray(b.steps)) throw E.policyInvalid('Informe a lista ordenada de passos (steps).');
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') throw E.policyInvalid('O campo "enabled" deve ser verdadeiro ou falso.');
  const seen = new Set();
  let previous = 0;
  const steps = b.steps.map((item, index) => {
    const raw = item && typeof item === 'object' ? item : { step: item };
    const step = assertDegradable(raw.step);
    if (seen.has(step)) throw E.policyInvalid(`O passo ${step} aparece mais de uma vez.`, { step });
    seen.add(step);
    const fallback = index === 0 ? firstThreshold : otherThreshold;
    const threshold = raw.threshold === undefined || raw.threshold === null ? fallback : Number(raw.threshold);
    if (!THRESHOLDS.includes(threshold)) throw E.policyInvalid(`O limiar do passo ${step} deve ser 50, 75, 90 ou 100.`, { step, threshold: raw.threshold });
    if (threshold < previous) throw E.policyInvalid('Os limiares da política não podem diminuir ao longo da lista de passos.', { step, threshold });
    previous = threshold;
    return { step, threshold };
  });
  return { budgetId: b.budgetId, steps, enabled: b.enabled !== false };
}

module.exports = { parsePolicy };
