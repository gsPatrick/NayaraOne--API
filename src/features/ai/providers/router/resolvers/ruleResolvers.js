'use strict';

/**
 * Resolvedores determinísticos por taskType (M9-D012, caminho RULE): contar, somar, listar, todo cálculo financeiro. Cada agente
 * (M9-D034 a D041) registra os seus. Um resolvedor recebe `(input, { tenant, transaction })` e devolve o resultado, ou `null`/
 * `undefined` quando não consegue resolver (aí o roteador segue para cache e modelo). O modelo nunca calcula: se o resolvedor
 * existe e responde, nenhum modelo é chamado e o custo é zero.
 */
class RuleResolverRegistry {
  constructor() { this.byTask = new Map(); this.guardList = []; }

  /** Guarda de fronteira (M9-D037): roda antes do resolvedor da tarefa; devolve resultado de regra (recusa) ou null para seguir. */
  registerGuard(guard) {
    if (typeof guard !== 'function') throw new TypeError('o guarda precisa ser uma função');
    if (!this.guardList.includes(guard)) this.guardList.push(guard);
  }

  guards() { return [...this.guardList]; }

  register(taskType, resolver) {
    if (typeof taskType !== 'string' || !taskType.trim()) throw new TypeError('taskType precisa de um nome');
    if (typeof resolver !== 'function') throw new TypeError('o resolvedor precisa ser uma função');
    this.byTask.set(taskType.toLowerCase(), resolver);
  }

  unregister(taskType) { return this.byTask.delete(String(taskType).toLowerCase()); }

  get(taskType) { return this.byTask.get(String(taskType || '').toLowerCase()) || null; }

  has(taskType) { return this.byTask.has(String(taskType || '').toLowerCase()); }

  list() { return [...this.byTask.keys()].sort(); }
}

const ruleResolvers = new RuleResolverRegistry();

module.exports = { RuleResolverRegistry, ruleResolvers };
