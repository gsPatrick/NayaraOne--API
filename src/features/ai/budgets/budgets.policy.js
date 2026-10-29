'use strict';

const { CRITICALITY } = require('./budgets.constants');

/**
 * Política de degradação (M9-D014, tabela do livro). Função pura: recebe `reached(pct)` (o orçamento que governa já consumiu pct%?),
 * a criticidade do agente (uma só, a da versão ativa), a ação ao chegar em 100% e o limiar de degradação (parâmetros).
 *   < degradeFrom                 -> normal (todos os caminhos)
 *   degradeFrom a < 100, não crítico -> só RULE, CACHE e modelo pequeno
 *   >= 100, não crítico           -> BLOCK: só RULE (429 para o resto); DEGRADE: só RULE e CACHE
 *   >= 100, crítico               -> só RULE, CACHE e modelo pequeno (o "fallback definido"); avançado é 429
 * EMBEDDING conta como modelo pequeno.
 */
const ALL = ['RULE', 'CACHE', 'SMALL_MODEL', 'EMBEDDING', 'ADVANCED_MODEL'];
const SMALL = ['RULE', 'CACHE', 'SMALL_MODEL', 'EMBEDDING'];

function budgetPolicy({ reached, criticality, actionAt100, degradeFrom }) {
  const critical = criticality === CRITICALITY.CRITICAL;
  if (reached(100)) {
    if (critical) return { state: 'EXHAUSTED', allowedPaths: SMALL };
    return { state: 'EXHAUSTED', allowedPaths: actionAt100 === 'DEGRADE' ? ['RULE', 'CACHE'] : ['RULE'] };
  }
  if (!critical && reached(degradeFrom)) return { state: 'DEGRADED', allowedPaths: SMALL };
  return { state: 'NORMAL', allowedPaths: ALL };
}

module.exports = { budgetPolicy };
