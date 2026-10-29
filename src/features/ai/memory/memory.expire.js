'use strict';

const V = require('./memory.input');
const repo = require('./memory.repository');

/**
 * Passa para EXPIRED toda memória ACTIVE da empresa que venceu (regra 2). Expirada não volta (o gatilho recusa). A leitura já ignora
 * a vencida pelo relógio; o job só deixa o estado coerente. Devolve a quantidade.
 */
async function expireMemories(ctx, transaction, { now = new Date() } = {}) {
  V.ctxOk(ctx);
  return repo.expireDue(ctx, now, transaction);
}

module.exports = { expireMemories };
