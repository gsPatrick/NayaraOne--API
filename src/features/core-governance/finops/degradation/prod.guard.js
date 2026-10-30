'use strict';

const { STEPS, CRITICAL_HINTS, INFRA_SHUTDOWN_HINTS } = require('./degradation.constants');
const E = require('./degradation.errors');

const norm = (name) => String(name || '').trim().toUpperCase();
const hasHint = (name, hints) => hints.some((hint) => name.includes(hint));

/**
 * Regra dura do livro (M9-D863 §3.1): nenhum código de FinOps desliga, pausa ou escala para zero recurso de infraestrutura de PROD. Toda ação de degradação
 * (cadastro de política e aplicação pelo job) passa por aqui antes de qualquer efeito: só os cinco interruptores de função são aceitos.
 *  - nome de função crítica (login, financeiro, jurídico, pagamento, kill switch, restore...): 422 GOV_FINOPS_CRITICAL_NOT_DEGRADABLE;
 *  - nome que desligaria infraestrutura (SHUTDOWN, STOP_, SCALE_TO_ZERO...): 403 GOV_FINOPS_PROD_PROTECTED;
 *  - qualquer outro nome fora da lista fechada: 422 GOV_FINOPS_POLICY_INVALID.
 */
function assertDegradable(step) {
  const name = norm(step);
  if (STEPS.includes(name)) return name;
  if (hasHint(name, CRITICAL_HINTS)) throw E.criticalNotDegradable({ step: String(step) });
  if (hasHint(name, INFRA_SHUTDOWN_HINTS)) throw E.prodProtected({ step: String(step) });
  throw E.policyInvalid(`O passo "${String(step).slice(0, 60)}" não existe. Passos aceitos: ${STEPS.join(', ')}.`, { step: String(step).slice(0, 60), accepted: STEPS });
}

module.exports = { assertDegradable };
