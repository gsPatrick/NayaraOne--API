'use strict';

const { AiRun } = require('../../../../models');
const { acquireRunKeyLock } = require('../../readmodels/runSupport.readmodel');
const E = require('./runs.errors');
const C = require('./runs.constants');
const V = require('./runs.validation');
const { toRun } = require('./runs.mapper');
const { computeRunCost } = require('./runCost');
const { publishRunEvent, auditRun } = require('./runEvents');
const { onAiRunFinished } = require('../../../core-governance/finops/finops.hooks');
const { sanitizeSummary, summaryLimit } = require('../../audit/auditSanitizer');

/** Traduz recusas do banco (gatilhos) e deixa passar qualquer outro erro. */
async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    throw E.fromDbError(err) || err;
  }
}

async function loadOwn(ctx, id, transaction, { lock = false } = {}) {
  if (!V.isUuid(id)) throw E.notFound();
  const row = await AiRun.findOne({ where: { id, companyId: ctx.companyId }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!row) throw E.notFound();
  return row;
}

/**
 * Abre um run (RUNNING). Com `idempotencyKey` repetida na empresa devolve o run existente (`replay: true`, HTTP 200 na rota)
 * sem criar outro nem gerar novo custo; a mesma chave com `requestHash` diferente é 409. Entrada: { stamp (runStamp do
 * agente), purpose, inputSummary, idempotencyKey, requestHash, parentRunId, snapshotAt, correlationId }.
 */
async function startRun(ctx, data, transaction) {
  V.ctxOk(ctx);
  const d = V.parseStart(data);
  return guarded(async () => {
    d.inputSummary = sanitizeSummary(d.inputSummary, await summaryLimit(ctx, transaction));
    if (d.idempotencyKey) {
      await acquireRunKeyLock(ctx.companyId, d.idempotencyKey, transaction);
      const existing = await AiRun.findOne({ where: { companyId: ctx.companyId, idempotencyKey: d.idempotencyKey }, transaction });
      if (existing) {
        if (d.requestHash && existing.requestHash && existing.requestHash !== d.requestHash) throw E.idempotencyConflict();
        return { run: toRun(existing), replay: true };
      }
    }
    if (d.parentRunId) await loadOwn(ctx, d.parentRunId, transaction);
    const row = await AiRun.create({
      groupId: ctx.groupId, companyId: ctx.companyId, userId: ctx.userId || null, agentName: d.agentName, agentId: d.agentId,
      agentVersion: d.agentVersion, purpose: d.purpose, inputSummary: d.inputSummary, status: 'RUNNING', routingPath: d.routingPath,
      idempotencyKey: d.idempotencyKey, requestHash: d.requestHash, parentRunId: d.parentRunId, conversationId: d.conversationId, snapshotAt: d.snapshotAt,
      correlationId: d.correlationId, startedAt: new Date(), createdBy: ctx.userId || null, updatedBy: ctx.userId || null,
    }, { transaction });
    const run = toRun(row);
    await auditRun(ctx, 'ai.run.started', run, null, 'Execução da NAY iniciada.', transaction);
    return { run, replay: false };
  });
}

/** Campos do UPDATE a partir da entrada validada; o custo vem de costAmount ou de tokens x preço por token (BigInt, sem float). */
function fieldsToUpdate(f, current) {
  const set = { status: f.status, updatedBy: undefined };
  for (const k of ['inputSummary', 'outputSummary', 'providerCode', 'modelCode', 'routingPath', 'groundingStatus', 'tokensIn', 'tokensOut', 'latencyMs',
    'confidence', 'blockedReason', 'errorCode', 'fallbackTrail', 'snapshotAt', 'escalated', 'cached']) {
    if (f[k] !== undefined) set[k] = f[k];
  }
  if (f.costAmount !== undefined) {
    set.costAmount = f.costAmount;
  } else if (f.priceIn !== undefined || f.priceOut !== undefined) {
    set.costAmount = computeRunCost({
      tokensIn: f.tokensIn ?? current.tokensIn, tokensOut: f.tokensOut ?? current.tokensOut, priceIn: f.priceIn ?? '0', priceOut: f.priceOut ?? '0',
    });
  }
  if (C.FINAL_STATUSES.includes(f.status)) set.finishedAt = new Date();
  return set;
}

/**
 * Muda o estado do run (e grava provider, modelo, tokens, custo, aterramento etc.). Linha travada com FOR UPDATE; o gatilho do
 * banco recusa estado final alterado (409 AI_RUN_IMMUTABLE) e transição fora da máquina (409 AI_RUN_TRANSITION).
 * COMPLETED e FAILED emitem ai.run.completed / ai.run.failed na mesma transação.
 */
async function finishRun(ctx, runId, data, transaction) {
  V.ctxOk(ctx);
  const f = V.parseFinish(data);
  return guarded(async () => {
    if (f.outputSummary !== undefined || f.inputSummary !== undefined) {
      const limit = await summaryLimit(ctx, transaction);
      if (f.outputSummary !== undefined) f.outputSummary = sanitizeSummary(f.outputSummary, limit);
      if (f.inputSummary !== undefined) f.inputSummary = sanitizeSummary(f.inputSummary, limit);
    }
    const row = await loadOwn(ctx, runId, transaction, { lock: true });
    const before = toRun(row);
    if (C.FINAL_STATUSES.includes(row.status)) throw E.immutable();
    if (f.status !== row.status && !(C.TRANSITIONS[row.status] || []).includes(f.status)) throw E.badTransition(row.status, f.status);
    const set = fieldsToUpdate(f, row);
    set.updatedBy = ctx.userId || null;
    await row.update(set, { transaction });
    await row.reload({ transaction });
    const run = toRun(row);
    await auditRun(ctx, 'ai.run.state_changed', run, before, `Execução da NAY: ${before.status} para ${run.status}.`, transaction);
    await publishRunEvent(ctx, run, transaction);
    await onAiRunFinished(ctx, run, C.FINAL_STATUSES, transaction); // M9-D860: custo ESTIMATED da hora no ledger do FinOps
    return run;
  });
}

module.exports = { startRun, finishRun, loadOwn, guarded };
