'use strict';

/**
 * Travas de gravação de um parâmetro (M9-D034): quem é dono da regra registra `(valor, tenant, actorUserId, transaction) => Promise`
 * que lança (AppError) para recusar o valor. Rodam depois da validação do schema e antes de qualquer escrita; o parâmetro sem trava
 * segue como sempre. A trava é do serviço de parâmetros, não da tela: vale para qualquer caminho que grave o valor.
 */
const guards = new Map();

function registerSettingGuard(key, guard) {
  if (typeof guard !== 'function') throw new TypeError('a trava do parâmetro precisa ser uma função');
  guards.set(key, guard);
}

async function runSettingGuard(key, value, tenant, actorUserId, transaction) {
  const guard = guards.get(key);
  if (guard) await guard(value, tenant, actorUserId, transaction);
}

module.exports = { registerSettingGuard, runSettingGuard };
