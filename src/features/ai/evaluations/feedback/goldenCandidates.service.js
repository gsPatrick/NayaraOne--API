'use strict';

const { AiGoldenCandidate } = require('../../../../models');
const E = require('../evaluations.errors');
const V = require('../evaluations.validation');
const C = require('../evaluations.constants');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');

const toCandidate = (c) => ({
  id: c.id, feedbackId: c.feedbackId, runId: c.runId, agentCode: c.agentCode, category: c.category, comment: c.comment, status: c.status,
  decidedBy: c.decidedBy, decidedAt: c.decidedAt ? new Date(c.decidedAt).toISOString() : null, decisionNote: c.decisionNote,
});

async function listCandidates(ctx, filters = {}, transaction) {
  V.ctxOk(ctx);
  const where = { companyId: ctx.companyId };
  if (filters.status) where.status = String(filters.status).trim().toUpperCase();
  const rows = await AiGoldenCandidate.findAll({ where, order: [['created_at', 'DESC'], ['id', 'ASC']], limit: 100, transaction });
  return rows.map(toCandidate);
}

/**
 * Decisão humana sobre o candidato (ai:evaluate): APPROVED ou REJECTED, uma vez. Só o caso aprovado pode entrar no golden
 * dataset (M9-D033); aprovar aqui não escreve nada no dataset nem em regra alguma. Repetir a mesma decisão da mesma pessoa
 * devolve o resultado; decisão diferente depois de decidido é 409.
 */
async function decideCandidate(ctx, id, decision, data, transaction) {
  V.ctxOk(ctx);
  if (!ctx.userId || ctx.serviceIdentity === true) throw E.humanOnly();
  if (!V.isUuid(id)) throw E.candidateNotFound();
  const note = V.parseNote(data && data.note, C.COMMENT_MAX);
  const row = await AiGoldenCandidate.findOne({ where: { id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!row) throw E.candidateNotFound();
  if (row.status !== 'PENDING') {
    if (row.status === decision && row.decidedBy === ctx.userId) return { candidate: toCandidate(row), replayed: true };
    throw E.candidateState();
  }
  const before = toCandidate(row);
  row.status = decision;
  row.decidedBy = ctx.userId;
  row.decidedAt = new Date();
  row.decisionNote = note;
  try {
    await row.save({ transaction });
  } catch (err) {
    throw E.fromDbError(err) || err;
  }
  const after = toCandidate(row);
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId, action: `ai.golden_candidate.${decision.toLowerCase()}`, entityType: 'AiGoldenCandidate',
    entityId: row.id, beforeJson: { id: before.id, status: before.status }, afterJson: { id: after.id, status: after.status, decidedBy: after.decidedBy },
    reason: 'Candidato a caso do golden dataset decidido por uma pessoa.',
  }, transaction);
  return { candidate: after, replayed: false };
}

module.exports = { listCandidates, decideCandidate };
