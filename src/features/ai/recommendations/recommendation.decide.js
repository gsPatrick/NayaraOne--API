'use strict';

const { AiRecommendation } = require('../../../models');
const E = require('./recommendation.errors');
const V = require('./recommendation.validation');
const C = require('./recommendation.constants');
const P = require('./recommendation.permissions');
const { toRecommendation } = require('./recommendation.mapper');
const { readRecommendationParams } = require('./recommendation.params');
const { publishRecommendationEvent, auditRecommendation } = require('./recommendation.events');
const { getSnapshotChecker } = require('./recommendation.snapshot');
const support = require('../readmodels/recommendationSupport.readmodel');

/** Traduz a recusa do gatilho do banco e deixa passar qualquer outro erro. */
async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    throw E.fromDbError(err) || err;
  }
}

/** Carrega a recomendação da empresa com a linha travada (FOR UPDATE): duas decisões simultâneas se serializam. */
async function lockOwn(ctx, id, transaction) {
  if (!V.isUuid(id)) throw E.notFound();
  const row = await AiRecommendation.findOne({ where: { id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!row) throw E.notFound();
  return row;
}

/** Quem solicitou o run só decide risco HIGH/CRITICAL daquele run quando o parâmetro de aprovador distinto está desligado. */
async function assertDistinctApprover(ctx, row, params, transaction) {
  if (!params.distinctApprover || !row.aiRunId || !C.DISTINCT_APPROVER_RISKS.includes(row.riskLevel)) return;
  const requester = await support.runRequester(row.aiRunId, ctx.companyId, transaction);
  if (requester && requester === ctx.userId) throw E.sameRequester();
}

/**
 * Decide uma recomendação PENDING (aceitar ou rejeitar). Ordem: só humano; existe na empresa; permissão; replay do mesmo
 * decisor devolve o resultado sem nova escrita; fora de PENDING é 409; (aceite) snapshot desatualizado vira STALE; aprovador
 * distinto; escrita com auditoria e evento na mesma transação. Aceite de informativa fecha com outcome NOT_APPLICABLE.
 */
async function decide(ctx, id, decision, data, transaction) {
  V.ctxOk(ctx);
  P.assertHuman(ctx);
  return guarded(async () => {
    const params = await readRecommendationParams(ctx, transaction);
    const reason = V.parseReason(data, { required: decision === 'REJECTED' && params.reasonRequired });
    const row = await lockOwn(ctx, id, transaction);
    const before = toRecommendation(row);
    P.assertCanDecide(ctx, before);
    if (row.decision === decision && row.decidedByUserId === ctx.userId) return { recommendation: before, replayed: true };
    if (row.status !== 'PENDING') throw E.state();
    await assertDistinctApprover(ctx, row, params, transaction);
    if (decision === 'ACCEPTED' && before.proposedAction && before.proposedAction.snapshot_hash) {
      const checker = getSnapshotChecker();
      if (checker && (await checker(before, ctx, transaction)) !== before.proposedAction.snapshot_hash) {
        row.status = 'STALE';
        row.updatedBy = ctx.userId;
        row.outcomeDetail = 'O snapshot mudou antes da decisão.';
        await row.save({ transaction });
        const stale = toRecommendation(row);
        await auditRecommendation(ctx, 'ai.recommendation.stale', stale, before, 'Proposta desatualizada: não pode mais ser aceita.', transaction);
        return { recommendation: stale, replayed: false, stale: true };
      }
    }
    row.status = decision;
    row.decision = decision;
    row.decisionReason = reason;
    row.decidedByUserId = ctx.userId;
    row.decidedAt = new Date();
    row.updatedBy = ctx.userId;
    if (decision === 'ACCEPTED' && !before.proposedAction) {
      row.outcome = 'NOT_APPLICABLE';
      row.outcomeAt = row.decidedAt;
    }
    await row.save({ transaction });
    const rec = toRecommendation(row);
    const accepted = decision === 'ACCEPTED';
    await auditRecommendation(ctx, accepted ? 'ai.recommendation.accepted' : 'ai.recommendation.rejected', rec, before,
      accepted ? 'Recomendação da NAY aceita por uma pessoa.' : 'Recomendação da NAY rejeitada por uma pessoa.', transaction);
    await publishRecommendationEvent(ctx, accepted ? C.EVENTS.accepted : C.EVENTS.rejected, rec, transaction);
    return { recommendation: rec, replayed: false };
  });
}

const acceptRecommendation = (ctx, id, data, transaction) => decide(ctx, id, 'ACCEPTED', data, transaction);
const rejectRecommendation = (ctx, id, data, transaction) => decide(ctx, id, 'REJECTED', data, transaction);

module.exports = { acceptRecommendation, rejectRecommendation, lockOwn, guarded, assertDistinctApprover };
