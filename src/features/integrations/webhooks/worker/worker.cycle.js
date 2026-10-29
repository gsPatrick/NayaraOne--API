'use strict';

const { sequelize } = require('../../../../models');
const { tenantTx } = require('../../dispatch/worker/tenantTx');
const { claimBatch, markFailed } = require('../../inbox');
const { readIntakeParams } = require('../intake/intake.params');
const { processEvent } = require('./worker.process');
const { deadLetterInvalid } = require('./worker.deadLetter');
const { PermanentWebhookFailure } = require('./worker.errors');

/**
 * runIntakeCycle — uma rodada do worker da caixa de entrada para UMA empresa (M9-D212 3.2): pega até integration.webhook.worker_batch_size eventos RECEIVED/FAILED vencidos
 * (FOR UPDATE SKIP LOCKED: dois workers nunca pegam o mesmo) e processa cada um num SAVEPOINT da mesma transação. Sucesso: PROCESSED. Dado inválido: fila morta, sem
 * retry. Falha transitória (banco, tempo): o SAVEPOINT desfaz o evento inteiro (nada publicado pela metade) e ele volta a FAILED com a próxima tentativa pela espera
 * configurada; ao esgotar integration.inbox.max_attempts vai à fila morta com ATTEMPTS_EXHAUSTED. Se o processo morrer no meio, a transação inteira é desfeita e os eventos
 * continuam RECEIVED: nenhum fica preso em PROCESSING.
 */
async function runIntakeCycle(ctx) {
  return tenantTx(ctx, async (transaction) => {
    const params = await readIntakeParams(ctx, transaction);
    const rows = await claimBatch(ctx, params.workerBatchSize, transaction);
    const resumo = { claimed: rows.length, processed: 0, notApplied: 0, deadLettered: 0, failed: 0 };
    for (const row of rows) {
      try {
        const r = await sequelize.transaction({ transaction }, (savepoint) => processEvent(ctx, row, savepoint));
        resumo.processed += 1;
        if (!r.applied) resumo.notApplied += 1;
      } catch (err) {
        await row.reload({ transaction });
        if (err instanceof PermanentWebhookFailure) {
          await deadLetterInvalid(ctx, row, err, transaction);
          resumo.deadLettered += 1;
        } else {
          const depois = await markFailed(ctx, row, `Falha transitória: ${String(err.message).slice(0, 200)}`, transaction);
          if (depois.status === 'DEAD_LETTER') resumo.deadLettered += 1; else resumo.failed += 1;
        }
      }
    }
    return resumo;
  });
}

module.exports = { runIntakeCycle };
