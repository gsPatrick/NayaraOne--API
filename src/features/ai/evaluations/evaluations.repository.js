'use strict';

const { AiEvaluation, AiEvaluationItem } = require('../../../models');

/** Acesso a ai.evaluations e ai.evaluation_items pelos modelos. Sempre na transação do tenant (a RLS FORCE decide o que a empresa enxerga). */
const own = (ctx) => ({ companyId: ctx.companyId });

const findOwn = (ctx, id, transaction, { lock = false } = {}) => AiEvaluation.findOne({ where: { id, ...own(ctx) }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });

const findByIdempotency = (ctx, key, transaction) => AiEvaluation.findOne({ where: { ...own(ctx), idempotencyKey: key }, transaction });

const listOwn = (ctx, filters, limit, transaction) => AiEvaluation.findAll({
  where: { ...own(ctx), ...filters }, order: [['created_at', 'DESC'], ['id', 'ASC']], limit, transaction,
});

const itemsOf = (ctx, evaluationId, transaction) => AiEvaluationItem.findAll({
  where: { evaluationId, ...own(ctx) }, order: [['created_at', 'ASC'], ['caseId', 'ASC']], transaction,
});

const insertQueued = (ctx, data, transaction) => AiEvaluation.create({
  groupId: ctx.groupId, companyId: ctx.companyId, agentCode: data.agentCode, agentVersion: data.agentVersion, providerCode: data.providerCode,
  suite: data.suite, status: 'QUEUED', idempotencyKey: data.idempotencyKey, triggeredBy: ctx.userId || null,
}, { transaction });

/** A próxima avaliação QUEUED da empresa (ou a pedida), travada; outra conexão pula a travada (SKIP LOCKED). */
const claimQueued = (ctx, id, transaction) => AiEvaluation.findOne({
  where: { ...own(ctx), status: 'QUEUED', ...(id ? { id } : {}) }, order: [['created_at', 'ASC']], transaction,
  lock: transaction.LOCK.UPDATE, skipLocked: true,
});

const insertItem = (ctx, evaluationId, item, transaction) => AiEvaluationItem.create({
  groupId: ctx.groupId, companyId: ctx.companyId, evaluationId, caseId: item.caseId, category: item.category, inputHash: item.inputHash,
  expected: item.expected, actualSummary: item.actualSummary, passed: item.passed, score: item.score, latencyMs: item.latencyMs,
  costAmount: item.costAmount, details: item.details,
}, { transaction });

module.exports = { findOwn, findByIdempotency, listOwn, itemsOf, insertQueued, claimQueued, insertItem };
