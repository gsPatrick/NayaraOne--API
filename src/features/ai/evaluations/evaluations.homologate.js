'use strict';

const V = require('./evaluations.validation');
const E = require('./evaluations.errors');
const C = require('./evaluations.constants');
const repo = require('./evaluations.repository');
const agentRepo = require('../agents/agents.repository');
const { isHighImpact } = require('./highImpact');
const { toEvaluation } = require('./evaluations.mapper');
const { publishEvaluationEvent, auditEvaluation } = require('./evaluations.events');

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    throw E.fromDbError(err) || err;
  }
}

/**
 * Homologação humana (AI-015, ai:evaluate): uma avaliação PASSED só é "elegível"; uma pessoa diferente de quem a disparou a
 * homologa, com nota (obrigatória para agente de alto impacto). Ordem: só pessoa; existe na empresa; trava da linha; replay
 * do mesmo homologador devolve o resultado; outra pessoa depois de homologada é 409; FAILED/ERROR é 409; quem disparou é 403.
 * A homologação nunca ativa o agente: ativar é decisão separada (ai:admin, M9-D004).
 */
async function homologateEvaluation(ctx, id, data, transaction) {
  V.ctxOk(ctx);
  if (!ctx.userId || ctx.serviceIdentity === true || ctx.actorType === 'NAY') throw E.humanOnly();
  return guarded(async () => {
    if (!V.isUuid(id)) throw E.notFound();
    const row = await repo.findOwn(ctx, id, transaction, { lock: true });
    if (!row) throw E.notFound();
    if (row.homologatedBy) {
      if (row.homologatedBy === ctx.userId) return { evaluation: toEvaluation(row), replayed: true };
      throw E.state();
    }
    if (row.status !== 'PASSED') throw E.notPassed();
    if (row.triggeredBy && row.triggeredBy === ctx.userId) throw E.selfBlocked();
    const agent = await agentRepo.findOwn(ctx, row.agentCode, row.agentVersion, transaction);
    const noteRequired = Boolean(agent && isHighImpact(agent));
    const note = V.parseNote(data && data.note, C.NOTE_MAX, { required: noteRequired, onMissing: E.noteRequired });
    const before = toEvaluation(row);
    row.homologatedBy = ctx.userId;
    row.homologatedAt = new Date();
    row.homologationNote = note;
    await row.save({ transaction });
    const evaluation = toEvaluation(row);
    await auditEvaluation(ctx, 'ai.evaluation.homologated', evaluation, before, `Avaliação da versão ${row.agentVersion} do agente ${row.agentCode} homologada por uma pessoa.`, transaction);
    await publishEvaluationEvent(ctx, C.EVENTS.homologated, evaluation, transaction);
    return { evaluation, replayed: false };
  });
}

module.exports = { homologateEvaluation };
