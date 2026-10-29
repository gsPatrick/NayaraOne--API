'use strict';

const V = require('./runs.validation');
const E = require('./runs.errors');
const C = require('./runs.constants');
const { toRun } = require('./runs.mapper');
const { loadOwn, guarded } = require('./runLifecycle');
const { sanitizeSummary, summaryLimit } = require('../../audit/auditSanitizer');

const FIELDS = ['providerCode', 'modelCode', 'routingPath', 'tokensIn', 'tokensOut', 'latencyMs', 'fallbackTrail', 'escalated', 'cached', 'snapshotAt'];

/**
 * Grava o que o run já gastou SEM mudar o estado (passo 10 do orquestrador, M9-D020): provedor, modelo, caminho, tokens, custo real e
 * o resumo da saída parcial. O run continua RUNNING (ou AWAITING_APPROVAL): o custo já foi gasto, mesmo que a saída seja reprovada no
 * passo seguinte, e o estado final só é gravado depois de validar a saída (`finishRun`). Run em estado final: 409 AI_RUN_IMMUTABLE.
 */
async function recordRunProgress(ctx, runId, data, transaction) {
  V.ctxOk(ctx);
  const f = V.parseFinish({ status: 'FAILED', ...data });
  return guarded(async () => {
    const row = await loadOwn(ctx, runId, transaction, { lock: true });
    if (C.FINAL_STATUSES.includes(row.status)) throw E.immutable();
    const set = { updatedBy: ctx.userId || null };
    for (const k of FIELDS) if (f[k] !== undefined) set[k] = f[k];
    if (f.costAmount !== undefined) set.costAmount = f.costAmount;
    if (f.outputSummary !== undefined) set.outputSummary = sanitizeSummary(f.outputSummary, await summaryLimit(ctx, transaction));
    await row.update(set, { transaction });
    await row.reload({ transaction });
    return toRun(row);
  });
}

module.exports = { recordRunProgress };
