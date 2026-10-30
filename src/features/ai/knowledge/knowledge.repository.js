'use strict';

const { KnowledgeEntry } = require('../../../models');
const dataClassification = require('../../../shared/data-classification/scale');
const { acquireFactKeyLock } = require('../readmodels/knowledgeSupport.readmodel');

/** Acesso a ai.knowledge_entries pelos modelos. Sempre dentro da transação do tenant (RLS FORCE decide o que a empresa enxerga). */
const own = (ctx) => ({ companyId: ctx.companyId });
const lockOpt = (transaction, lock) => (lock ? { lock: transaction.LOCK.UPDATE } : {});

const lockFactKey = (ctx, factKey, transaction) => acquireFactKeyLock(ctx.companyId, factKey, transaction);

function findById(ctx, id, transaction, { lock = false } = {}) {
  return KnowledgeEntry.findOne({ where: { id, ...own(ctx) }, transaction, ...lockOpt(transaction, lock) });
}

function list(ctx, filters, transaction) {
  // M9-D910: o banco guarda a escala nova (LOW..RESTRICTED); o filtro do módulo de IA ainda vem como PUBLIC/INTERNAL/CONFIDENTIAL/RESTRICTED.
  const where = { ...own(ctx), ...filters, ...(filters && filters.classification ? { classification: dataClassification.normalize(filters.classification) } : {}) };
  return KnowledgeEntry.findAll({ where, order: [['factKey', 'ASC'], ['version', 'DESC']], transaction });
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
