'use strict';

const E = require('./memory.errors');
const V = require('./memory.input');
const repo = require('./memory.repository');
const { persistMemory, toMemory } = require('./memory.write');

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    throw E.fromDbError(err) || err;
  }
}

/**
 * Grava um fato estruturado como memória ACTIVE (M9-D009). Devolve { memory, replayed, piiRemoved }. A mesma `idempotencyKey` na empresa
 * devolve a memória já gravada (replayed true) sem duplicar. Falhou no meio, nada fica (a transação é de quem chama).
 */
async function saveMemory(ctx, data, transaction, { now = new Date() } = {}) {
  V.ctxOk(ctx);
  const input = V.parseSave(data);
  return guarded(async () => {
    if (input.idempotencyKey) {
      await repo.lockIdempotency(ctx, input.idempotencyKey, transaction);
      const existing = await repo.findByKey(ctx, input.idempotencyKey, transaction);
      if (existing) return { memory: toMemory(existing), replayed: true, piiRemoved: [] };
    }
    const out = await persistMemory(ctx, input, transaction, { now, auditAction: 'ai.memory.created', auditReason: 'Memória da NAY gravada.' });
    return { ...out, replayed: false };
  });
}

module.exports = { saveMemory, guarded };
