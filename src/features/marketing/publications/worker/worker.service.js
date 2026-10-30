'use strict';

const logger = require('../../../../utils/logger');
const { recomputeItemStatus } = require('../schedule/schedule.status');
const { readWorkerParams } = require('./worker.settings');
const { claimDue } = require('./worker.claim');
const { sendJob } = require('./worker.call');
const { applySend } = require('./worker.outcome');
const { reconcileDue, recoverAbandoned } = require('./worker.reconcile');
const { statusDue, metricsDue } = require('./worker.followup');

/**
 * Um ciclo do worker de publicação (M9-D411) para UMA empresa. `withTx(fn)` abre a transação da empresa (RLS) e chama `fn(transaction)`: o job de produção abre uma por etapa
 * (a reserva do job, RUNNING, é gravada e liberada ANTES de falar com o canal, de modo que a queda do processo deixa um RUNNING que a varredura trata como timeout), e o teste
 * passa a própria transação. Ordem: (1) recupera RUNNING abandonado, (2) reconcilia UNKNOWN vencido, (3) pega e envia os PENDING vencidos, (4) consulta posts em processamento,
 * (5) coleta métricas D+N. O status dos itens é recalculado ao fim de cada fase, fora das transações dos jobs. Falha de uma fase é registrada e não impede as seguintes.
 */
async function runWorkerCycle(tenant, { withTx, now = new Date(), scenarioFor } = {}) {
  const params = await withTx((transaction) => readWorkerParams(tenant, transaction));
  const touched = new Set();
  const base = { tenant, now, params, touched, scenarioFor };
  const summary = { intervalS: params.intervalS, recovered: 0, reconciled: 0, claimed: 0, sent: 0, skipped: {}, statusChecked: 0, metrics: 0, errors: 0 };

  const phase = async (name, fn) => {
    try {
      return await withTx((transaction) => fn({ ...base, transaction }));
    } catch (err) {
      summary.errors += 1;
      logger.error({ phase: name, companyId: tenant.companyId, err: err && err.message }, 'marketing.publication.worker.phase_failed');
      return null;
    }
  };
  const closeItems = async () => {
    for (const itemId of [...touched]) {
      touched.delete(itemId);
      await phase('close_item', (ctx) => recomputeItemStatus({ tenant, actor: null, itemId, reason: 'Status da publicação atualizado pelo worker.' }, ctx.transaction));
    }
  };

  summary.recovered = ((await phase('recover', recoverAbandoned)) || []).length;
  summary.reconciled = ((await phase('reconcile', reconcileDue)) || []).length;
  const claim = await phase('claim', claimDue);
  summary.claimed = claim ? claim.claimed.length : 0;
  summary.skipped = claim ? claim.skipped : {};
  await closeItems();
  for (const job of claim ? claim.claimed : []) {
    const sent = await phase('send', (ctx) => sendJob({ tenant, job, timeoutS: params.timeoutS, transaction: ctx.transaction, scenarioFor }));
    const applied = await phase('apply', (ctx) => applySend(ctx, job, sent || { kind: 'EXCEPTION', code: 'MKT_PUBLICATION_ADAPTER_EXCEPTION' }));
    if (applied && !applied.skipped) summary.sent += 1;
  }
  summary.statusChecked = ((await phase('status', statusDue)) || []).length;
  summary.metrics = ((await phase('metrics', metricsDue)) || []).filter((m) => m.collected).length;
  await closeItems();
  return summary;
}

module.exports = { runWorkerCycle };
