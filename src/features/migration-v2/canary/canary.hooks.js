'use strict';

/**
 * Ganchos do rollback de setor (M9-D904 §3.4): a M9-D907 registra aqui a criação dos `rollback_items` das operações externas do setor desde T0. Cada gancho roda na MESMA
 * transação do rollback, depois que o percentual voltou a 0, com `(tenant, sector, ctx, transaction)`; se um falhar, o rollback inteiro desfaz.
 */
const hooks = new Map();

function registerRollbackHook(name, fn) {
  if (typeof fn !== 'function') throw new Error('Gancho do rollback do canary deve ser uma função.');
  hooks.set(name, fn);
  return () => hooks.delete(name);
}

async function runRollbackHooks(tenant, sector, ctx, transaction) {
  const out = {};
  for (const [name, fn] of hooks) {
     
    out[name] = await fn(tenant, sector, ctx, transaction);
  }
  return out;
}

module.exports = { registerRollbackHook, runRollbackHooks };
