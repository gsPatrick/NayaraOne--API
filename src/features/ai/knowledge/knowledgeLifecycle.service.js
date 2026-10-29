'use strict';

const E = require('./knowledge.errors');
const V = require('./knowledge.validation');
const repo = require('./knowledge.repository');
const { toEntry } = require('./knowledge.mapper');
const { auditKnowledge } = require('./knowledge.audit');
const { guarded } = require('./knowledgeRegistry.service');
const { enqueueKnowledge, retractKnowledge } = require('../retrieval/ingestion.knowledge');

/**
 * Homologa um DRAFT: o homologador precisa ser diferente de quem escreveu (403 AI_KNOWLEDGE_SELF_HOMOLOGATION). A versão
 * homologada anterior do mesmo `factKey` vira SUPERSEDED na MESMA transação; a trava por fact_key e o índice único parcial
 * garantem uma só HOMOLOGATED, mesmo com duas homologações simultâneas. Repetir sobre a já homologada devolve o estado atual.
 */
async function homologate(ctx, id, transaction) {
  V.ctxOk(ctx);
  if (!V.isUuid(id)) throw E.notFound();
  if (!ctx.userId) throw E.invalid('A homologação precisa de uma pessoa identificada.');
  return guarded(async () => {
    const peek = await repo.findById(ctx, id, transaction);
    if (!peek) throw E.notFound();
    await repo.lockFactKey(ctx, peek.factKey, transaction);
    const row = await repo.findById(ctx, id, transaction, { lock: true });
    if (row.status === 'HOMOLOGATED' && row.homologatedBy === ctx.userId) return toEntry(row);
    if (row.status !== 'DRAFT') throw E.badTransition(row.status, 'HOMOLOGATED');
    if (row.createdBy && row.createdBy === ctx.userId) throw E.selfHomologation();
    const before = toEntry(row);
    const current = await repo.findHomologated(ctx, row.factKey, transaction);
    if (current && current.version > row.version) throw E.staleVersion(current.version);
    const now = new Date();
    if (current) {
      const prior = toEntry(current);
      await current.update({ status: 'SUPERSEDED', isActive: false, updatedBy: ctx.userId, lockVersion: current.lockVersion + 1 }, { transaction });
      await auditKnowledge(ctx, 'ai.knowledge.superseded', toEntry(current), prior, `Substituída pela versão ${row.version}.`, transaction);
      await retractKnowledge(ctx, current.id, 'SUPERSEDED', transaction);
    }
    await row.update({ status: 'HOMOLOGATED', homologatedBy: ctx.userId, homologatedAt: now, isActive: true, updatedBy: ctx.userId, lockVersion: row.lockVersion + 1 }, { transaction });
    const entry = toEntry(row);
    await auditKnowledge(ctx, 'ai.knowledge.homologated', entry, before, `Conhecimento homologado (versão ${entry.version}).`, transaction);
    await enqueueKnowledge(ctx, row, transaction); // ingestão automática no RAG (M9-D022), na mesma transação
    return entry;
  });
}

/** Revoga uma HOMOLOGATED, com motivo obrigatório. REVOKED não reativa (cria-se nova versão). O RAG deixa de recuperá-la. */
async function revoke(ctx, id, body, transaction) {
  V.ctxOk(ctx);
  if (!V.isUuid(id)) throw E.notFound();
  if (!ctx.userId) throw E.invalid('A revogação precisa de uma pessoa identificada.');
  const reason = V.parseReason(body);
  return guarded(async () => {
    const peek = await repo.findById(ctx, id, transaction);
    if (!peek) throw E.notFound();
    await repo.lockFactKey(ctx, peek.factKey, transaction);
    const row = await repo.findById(ctx, id, transaction, { lock: true });
    if (row.status !== 'HOMOLOGATED') throw E.badTransition(row.status, 'REVOKED');
    const before = toEntry(row);
    await row.update({ status: 'REVOKED', revokedBy: ctx.userId, revokedAt: new Date(), revokeReason: reason, isActive: false, updatedBy: ctx.userId, lockVersion: row.lockVersion + 1 }, { transaction });
    const entry = toEntry(row);
    await auditKnowledge(ctx, 'ai.knowledge.revoked', entry, before, `Conhecimento revogado: ${reason}`, transaction);
    await retractKnowledge(ctx, row.id, 'REVOKED', transaction); // o RAG deixa de recuperar os chunks (M9-D022/D023)
    return entry;
  });
}

module.exports = { homologate, revoke };
