'use strict';

const { Op } = require('sequelize');
const { AiMemory, AiRun, AiRecommendation, KnowledgeEntry } = require('../../../models');
const { acquireMemoryLock } = require('../readmodels/memorySupport.readmodel');

/** Acesso a ai.memories pelos modelos. Sempre dentro da transação do tenant (RLS FORCE decide o que a empresa enxerga). */
const own = (ctx) => ({ companyId: ctx.companyId });

const lockIdempotency = (ctx, key, transaction) => acquireMemoryLock('idem', ctx.companyId, key, transaction);

const findByKey = (ctx, key, transaction) => AiMemory.findOne({ where: { ...own(ctx), idempotencyKey: key }, transaction });

function findById(ctx, id, transaction, { lock = false } = {}) {
  return AiMemory.findOne({ where: { id, ...own(ctx) }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
}

function insert(ctx, v, transaction) {
  return AiMemory.create({
    groupId: ctx.groupId, companyId: ctx.companyId, ownerUserId: v.ownerUserId, memoryType: v.type, subjectType: v.subjectType, subjectId: v.subjectId,
    scope: v.scope, agentCode: v.agentCode, value: v.value, sourceType: v.sourceType, sourceId: v.sourceId, classification: v.classification,
    purpose: v.purpose, validFrom: v.validFrom, expiresAt: v.expiresAt, status: 'ACTIVE', version: v.version || 1, supersedesId: v.supersedesId || null,
    idempotencyKey: v.idempotencyKey || null, createdBy: ctx.userId || null, updatedBy: ctx.userId || null,
  }, { transaction });
}

/** Origem da memória: run, recomendação ou conhecimento da MESMA empresa. Devolve os campos que as regras precisam, ou null. */
async function findSource(ctx, sourceType, sourceId, transaction) {
  const where = { id: sourceId, ...own(ctx) };
  if (sourceType === 'RUN') {
    const r = await AiRun.findOne({ where, transaction });
    return r && { sourceType, status: r.status };
  }
  if (sourceType === 'RECOMMENDATION') {
    const r = await AiRecommendation.findOne({ where, transaction });
    return r && { sourceType, status: r.status, decision: r.decision, outcome: r.outcome };
  }
  const k = await KnowledgeEntry.findOne({ where, transaction });
  return k && { sourceType, status: k.status, createdBy: k.createdBy };
}

/** Marca a anterior como SUPERSEDED (correção) ou INVALIDATED (invalidação); o gatilho garante a máquina de estados. */
const closeRow = (row, set, transaction) => row.update(set, { transaction });

/**
 * Memórias vigentes e visíveis à pessoa. `filters`: status, memoryType, subjectType, subjectId, agent. Visibilidade: COMPANY para todos;
 * USER e SESSION só do dono; AGENT só do agente informado (ou, na auditoria, de qualquer um).
 */
function listVisible(ctx, f, transaction) {
  const where = { ...own(ctx) };
  if (f.status) where.status = f.status;
  if (f.memoryType) where.memoryType = f.memoryType;
  if (f.subjectType) where.subjectType = f.subjectType;
  if (f.subjectId) where.subjectId = f.subjectId;
  if (f.activeOnly) {
    where.status = 'ACTIVE';
    where.validFrom = { [Op.lte]: f.now };
    where.expiresAt = { [Op.gt]: f.now };
  }
  const and = [];
  if (!f.audit) {
    const scopes = [{ scope: 'COMPANY' }];
    if (ctx.userId) scopes.push({ scope: { [Op.in]: ['USER', 'SESSION'] }, ownerUserId: ctx.userId });
    if (f.agent) scopes.push({ scope: 'AGENT', agentCode: f.agent });
    and.push({ [Op.or]: scopes });
  }
  if (!f.restricted) and.push({ classification: { [Op.ne]: 'RESTRICTED' } });
  if (and.length) where[Op.and] = and;
  return AiMemory.findAll({ where, order: [['validFrom', 'DESC'], ['created_at', 'DESC']], limit: f.limit, offset: f.offset || 0, transaction });
}

/** Passa para EXPIRED o que venceu (job diário). O gatilho só deixa ACTIVE seguir para EXPIRED. Devolve a contagem. */
async function expireDue(ctx, now, transaction) {
  const [n] = await AiMemory.update({ status: 'EXPIRED' }, { where: { ...own(ctx), status: 'ACTIVE', expiresAt: { [Op.lte]: now } }, transaction });
  return n;
}

module.exports = { lockIdempotency, findByKey, findById, insert, findSource, closeRow, listVisible, expireDue, acquireMemoryLock };
