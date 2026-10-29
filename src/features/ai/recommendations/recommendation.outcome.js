'use strict';

const E = require('./recommendation.errors');
const V = require('./recommendation.validation');
const C = require('./recommendation.constants');
const { toRecommendation } = require('./recommendation.mapper');
const { auditRecommendation } = require('./recommendation.events');
const { lockOwn, guarded } = require('./recommendation.decide');

/**
 * Grava o resultado da execução depois do aceite (quem chama é o executor da M9-D019): ACCEPTED -> EXECUTED | EXECUTION_FAILED.
 * Sem aceite prévio, ou repetido, é 409. Não decide nada: a decisão continua sendo da pessoa que aceitou.
 */
async function recordOutcome(ctx, id, data, transaction) {
  V.ctxOk(ctx);
  const outcome = data && data.outcome;
  if (!C.EXECUTION_OUTCOMES.includes(outcome)) throw E.invalid('Resultado inválido.', { permitidos: C.EXECUTION_OUTCOMES });
  const detail = V.text(data.detail, 'O detalhe do resultado', 1000);
  return guarded(async () => {
    const row = await lockOwn(ctx, id, transaction);
    const before = toRecommendation(row);
    if (row.status !== 'ACCEPTED' || !before.proposedAction) throw E.state('Esta recomendação não está aguardando o resultado da execução.');
    row.status = outcome;
    row.outcome = outcome;
    row.outcomeDetail = detail;
    row.outcomeAt = new Date();
    row.updatedBy = ctx.userId || null;
    await row.save({ transaction });
    const rec = toRecommendation(row);
    await auditRecommendation(ctx, 'ai.recommendation.outcome', rec, before, `Resultado da execução registrado: ${outcome}.`, transaction);
    return rec;
  });
}

/** PENDING -> STALE por decisão do executor (D019) quando percebe antes do aceite que a situação mudou. */
async function markStale(ctx, id, data, transaction) {
  V.ctxOk(ctx);
  const reason = V.text(data && data.reason, 'O motivo', 1000);
  return guarded(async () => {
    const row = await lockOwn(ctx, id, transaction);
    const before = toRecommendation(row);
    if (row.status !== 'PENDING') throw E.state();
    row.status = 'STALE';
    row.outcomeDetail = reason;
    row.updatedBy = ctx.userId || null;
    await row.save({ transaction });
    const rec = toRecommendation(row);
    await auditRecommendation(ctx, 'ai.recommendation.stale', rec, before, 'Proposta desatualizada: não pode mais ser aceita.', transaction);
    return rec;
  });
}

module.exports = { recordOutcome, markStale };
