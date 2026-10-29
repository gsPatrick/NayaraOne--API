'use strict';

const logger = require('../../../../utils/logger');
const { claimDue } = require('../dispatch.claim');
const { recoverStaleSending } = require('../dispatch.stale');
const { readWorkerParams } = require('./worker.params');
const { tenantTx } = require('./tenantTx');
const { processClaimed } = require('./worker.process');

/**
 * Uma rodada do worker para UMA empresa (M9-D214 3.2): recupera SENDING órfão, pega até `worker_batch_size` envios vencidos com
 * SKIP LOCKED e os leva a SENDING (commit ANTES de qualquer chamada) e processa cada um. Falha de um envio não derruba os outros.
 */
async function runDispatchCycle(ctx, { now = new Date(), limit } = {}) {
  const claimed = await tenantTx(ctx, async (transaction) => {
    const params = await readWorkerParams(ctx, transaction);
    await recoverStaleSending(ctx, transaction);
    const pegos = await claimDue(ctx, limit || params.batchSize, transaction);
    return pegos.map((d) => d.id);
  });
  const summary = { claimed: claimed.length, sent: 0, deferred: 0, failed: 0, errors: 0 };
  for (const id of claimed) {
    try {
      const r = await processClaimed(ctx, id, { now });
      if (r.deferred) summary.deferred += 1;
      else if (r.failed) summary.failed += 1;
      else if (r.ok) summary.sent += 1;
    } catch (err) {
      summary.errors += 1;
      logger.error({ dispatchId: id, err: err.message }, 'Falha ao processar o envio; ele fica em SENDING até a recuperação.');
    }
  }
  return summary;
}

module.exports = { runDispatchCycle };
