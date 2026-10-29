'use strict';

/**
 * Pontos de extensão da importação (M9-D832 §3.1). Cada guarda roda DEPOIS da validação e ANTES do comando normal, dentro da transação do item, e recusa lançando um erro de
 * governança (a operação segue RECORDED). A M9-D833 registra aqui a dupla checagem do pagamento emergencial; a M9-D832 só define o ponto e a ordem.
 */
const guards = [];

/** Registra uma guarda `async ({ tenant, actorUserId, operation, transaction }) => void`. */
function registerGuard(guard) {
  if (typeof guard !== 'function') throw new TypeError('A guarda da importação deve ser uma função.');
  guards.push(guard);
}

async function runGuards(context) {
  for (const guard of guards) await guard(context);
}

module.exports = { registerGuard, runGuards };
