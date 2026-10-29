'use strict';

/**
 * Porta do cache seguro (M9-D015): o roteador consulta `lookup(input, { tenant, transaction })` depois da regra e antes do modelo.
 * Hit devolve `{ result, key }` e o caminho é CACHE (custo zero). Enquanto a M9-D015 não registra o seu cache, a porta está vazia e
 * nunca há hit: nenhuma resposta é reaproveitada sem a política de elegibilidade dela.
 */
class CachePort {
  constructor() { this.lookupFn = null; }

  register(lookupFn) {
    if (lookupFn !== null && typeof lookupFn !== 'function') throw new TypeError('o cache precisa ser uma função');
    this.lookupFn = lookupFn;
  }

  get registered() { return typeof this.lookupFn === 'function'; }

  async lookup(input, scope) {
    return this.registered ? this.lookupFn(input, scope) : null;
  }
}

const cachePort = new CachePort();

module.exports = { CachePort, cachePort };
