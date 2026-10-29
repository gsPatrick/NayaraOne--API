'use strict';

const { Op } = require('sequelize');
const { KnowledgeEntry } = require('../../../models');
const V = require('./knowledge.validation');
const repo = require('./knowledge.repository');
const { toEntry } = require('./knowledge.mapper');
const { auditKnowledge } = require('./knowledge.audit');
const { retractKnowledge } = require('../retrieval/ingestion.knowledge');

/**
 * Conhecimento homologado cujo prazo (`valid_until`) passou em `now` vira EXPIRED (M9-D024): deixa de ser ativo e seus chunks saem da
 * busca (EXPIRED) na MESMA transação, com a trilha antes/depois. Expirada não volta a valer; a leitura já ignora a vencida pelo relógio,
 * este passo só deixa o estado coerente. Devolve quantas entradas mudaram. Repetir não muda nada.
 */
async function expireEnded(ctx, transaction, { now = new Date() } = {}) {
  V.ctxOk(ctx);
  const due = await KnowledgeEntry.findAll({ where: { companyId: ctx.companyId, status: 'HOMOLOGATED', validUntil: { [Op.lte]: now } }, transaction });
  let changed = 0;
  for (const peek of due) {
    await repo.lockFactKey(ctx, peek.factKey, transaction);
    const row = await repo.findById(ctx, peek.id, transaction, { lock: true });
    if (!row || row.status !== 'HOMOLOGATED') continue;
    const before = toEntry(row);
    await row.update({ status: 'EXPIRED', isActive: false, updatedBy: ctx.userId || null, lockVersion: row.lockVersion + 1 }, { transaction });
    await auditKnowledge(ctx, 'ai.knowledge.expired', toEntry(row), before, 'Prazo de validade do conhecimento encerrado.', transaction);
    await retractKnowledge(ctx, row.id, 'EXPIRED', transaction);
    changed += 1;
  }
  return changed;
}

module.exports = { expireEnded };
