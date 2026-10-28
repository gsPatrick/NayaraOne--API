'use strict';

const { KnowledgeEntry } = require('../../../models');
const { acquireFactKeyLock } = require('../readmodels/knowledgeSupport.readmodel');

/** Acesso a ai.knowledge_entries pelos modelos. Sempre dentro da transação do tenant (RLS FORCE decide o que a empresa enxerga). */
const own = (ctx) => ({ companyId: ctx.companyId });
const lockOpt = (transaction, lock) => (lock ? { lock: transaction.LOCK.UPDATE } : {});

const lockFactKey = (ctx, factKey, transaction) => acquireFactKeyLock(ctx.companyId, factKey, transaction);

function findById(ctx, id, transaction, { lock = false } = {}) {
  return KnowledgeEntry.findOne({ where: { id, ...own(ctx) }, transaction, ...lockOpt(transaction, lock) });
}

function list(ctx, filters, transaction) {
  return KnowledgeEntry.findAll({ where: { ...own(ctx), ...filters }, order: [['factKey', 'ASC'], ['version', 'DESC']], transaction });
}

async function nextVersion(ctx, factKey, transaction) {
  return ((await KnowledgeEntry.max('version', { where: { ...own(ctx), factKey }, paranoid: false, transaction })) || 0) + 1;
}

function findHomologated(ctx, factKey, transaction) {
  return KnowledgeEntry.findOne({ where: { ...own(ctx), factKey, status: 'HOMOLOGATED' }, transaction, lock: transaction.LOCK.UPDATE });
}

function insert(ctx, v, transaction) {
  return KnowledgeEntry.create({
    groupId: ctx.groupId, companyId: ctx.companyId, subjectType: v.subjectType, subjectId: v.subjectId ?? null, factKey: v.factKey, version: v.version,
    status: 'DRAFT', title: v.title, factValueJson: v.value, bodyStructured: v.bodyStructured ?? null, origin: v.origin ?? null,
    classification: v.classification, validFrom: v.validFrom ?? null, validUntil: v.validUntil ?? null, isActive: false, contentHash: v.contentHash,
    ownerUserId: v.ownerUserId ?? ctx.userId ?? null, sourceId: v.sourceId ?? null, createdBy: ctx.userId || null, updatedBy: ctx.userId || null,
  }, { transaction });
}

module.exports = { lockFactKey, findById, list, nextVersion, findHomologated, insert };
