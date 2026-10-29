'use strict';

const {
  saveMemory, recallMemories, invalidateMemory, correctMemory, listMemories, getMemory, proposeMemory, expireMemories, toContextSources,
} = require('./memory.service');

/**
 * MemoryService — memória empresarial estruturada da NAY (M9-D009). Fatos operacionais autorizados (decisão, preferência da empresa,
 * procedimento homologado, resultado de recomendação), com dono, escopo, origem, classificação e validade; nunca a conversa inteira.
 * Corrigir cria outra versão e invalidar guarda o motivo; nada se apaga. Cada método recebe (ctx, ..., transaction): a transação é de
 * quem chama (rota, job ou teste), sempre aberta com o tenant (RLS FORCE).
 */
class MemoryService {
  constructor() {
    this.nome = 'MemoryService';
  }

  save(ctx, data, transaction, opts) { return saveMemory(ctx, data, transaction, opts); }

  recall(ctx, opts, transaction, clock) { return recallMemories(ctx, opts, transaction, clock); }

  invalidate(ctx, id, data, transaction, opts) { return invalidateMemory(ctx, id, data, transaction, opts); }

  correct(ctx, id, data, transaction, opts) { return correctMemory(ctx, id, data, transaction, opts); }

  list(ctx, query, transaction, opts) { return listMemories(ctx, query, transaction, opts); }

  get(ctx, id, transaction) { return getMemory(ctx, id, transaction); }

  propose(ctx, data, transaction) { return proposeMemory(ctx, data, transaction); }

  expire(ctx, transaction, opts) { return expireMemories(ctx, transaction, opts); }

  /** Memórias vigentes no formato de fonte do ContextBuilder (M9-D027), com `sourceId` para a citação. */
  async recallAsSources(ctx, opts, transaction, clock) {
    return toContextSources(ctx, await recallMemories(ctx, opts, transaction, clock));
  }
}

module.exports = { MemoryService };
