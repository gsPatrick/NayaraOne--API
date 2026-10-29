'use strict';

const E = require('./memory.errors');
const V = require('./memory.input');
const policy = require('./memory.policy');
const repo = require('./memory.repository');
const { readMemoryParams } = require('./memory.params');
const { toMemory } = require('./memory.mapper');
const { visibleTo } = require('./memory.change');

/**
 * Lembrança para o contexto do run (M9-D009, regra 7): só ACTIVE, dentro de valid_from e de expires_at, no escopo da pessoa
 * (COMPANY; USER e SESSION do dono; AGENT do agente informado), sem RESTRICTED a quem não tem ai:restricted, no máximo
 * `ia.memoria.max_itens_contexto`. Invalidada, substituída ou expirada nunca volta aqui. Cada item traz `sourceId` para citação.
 * `opts`: { subject: { type, id }, agent, memoryType, limit }.
 */
async function recallMemories(ctx, opts, transaction, { now = new Date() } = {}) {
  V.ctxOk(ctx);
  policy.readScope(ctx);
  const o = opts || {};
  const params = await readMemoryParams(ctx, transaction);
  const limit = Math.min(Number.isInteger(o.limit) && o.limit > 0 ? o.limit : params.maxContextItems, params.maxContextItems);
  const rows = await repo.listVisible(ctx, {
    activeOnly: true, now, audit: false, restricted: policy.has(ctx, 'ai:restricted'), agent: o.agent || null, memoryType: o.memoryType,
    subjectType: o.subject && o.subject.type, subjectId: o.subject && o.subject.id !== undefined ? String(o.subject.id) : undefined, limit,
  }, transaction);
  return rows.map(toMemory);
}

/**
 * Lista para a tela/API: ai:audit enxerga a empresa; os demais, o que lhes pertence. Por padrão só as vigentes; `status` mostra o histórico.
 * `q`: { status, memoryType, subjectType, subjectId, limit, page }.
 */
async function listMemories(ctx, q, transaction, { now = new Date() } = {}) {
  V.ctxOk(ctx);
  const scope = policy.readScope(ctx);
  const params = await readMemoryParams(ctx, transaction);
  const f = q || {};
  const limit = Math.min(Number(f.limit) > 0 ? Math.floor(Number(f.limit)) : 20, 100);
  const page = Number(f.page) > 0 ? Math.floor(Number(f.page)) : 1;
  const status = f.status ? String(f.status).toUpperCase() : 'ACTIVE';
  const rows = await repo.listVisible(ctx, {
    status, activeOnly: false, now, audit: scope.audit, restricted: scope.restricted || policy.has(ctx, 'ai:admin'), memoryType: f.memoryType,
    subjectType: f.subjectType, subjectId: f.subjectId, limit, offset: (page - 1) * limit, agent: f.agent || null,
  }, transaction);
  return { items: rows.map(toMemory), page, limit, maxContextItems: params.maxContextItems };
}

async function getMemory(ctx, id, transaction) {
  V.ctxOk(ctx);
  policy.readScope(ctx);
  if (!V.isUuid(id)) throw E.notFound();
  const row = await repo.findById(ctx, id, transaction);
  if (!row || !visibleTo(ctx, row)) throw E.notFound();
  return toMemory(row);
}

module.exports = { recallMemories, listMemories, getMemory };
