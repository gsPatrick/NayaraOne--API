'use strict';

const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { getSetting } = require('../../settings/settings.service');
const logger = require('../../../utils/logger');
const { BATCH } = require('./ingest.constants');
const errors = require('./ingest.errors');
const { KEYS, INGEST_SETTING_DEFAULTS } = require('./ingest.settings');
const batches = require('./batch.repository');
const sources = require('./source.repository');
const { applyBatch, assertNoGap } = require('./applier');

/** Lê um parâmetro numérico da migração (padrão do catálogo se a empresa não definiu). */
async function numberSetting(tenant, key, transaction) {
  return Number(await getSetting(key, tenant, transaction, INGEST_SETTING_DEFAULTS[key]));
}

async function loadSettings(tenant) {
  return openTenantTx(tenant, async (transaction) => ({
    batchSize: await numberSetting(tenant, KEYS.BATCH_SIZE, transaction),
    overlapSeconds: await numberSetting(tenant, KEYS.OVERLAP_S, transaction),
    maxAttempts: await numberSetting(tenant, KEYS.MAX_ATTEMPTS, transaction),
    timeoutMinutes: await numberSetting(tenant, KEYS.BATCH_TIMEOUT_MIN, transaction),
    maxInProcess: await numberSetting(tenant, KEYS.EXEC_PER_PROCESS, transaction),
  }));
}

/** Lote RUNNING há mais que o prazo (processo caído no meio) é dado como FAILED para liberar a fonte; dentro do prazo, é GOV_MIG_BATCH_RUNNING. */
async function releaseStale(tenant, source, timeoutMinutes, transaction) {
  const running = await batches.findRunning(tenant, source.id, transaction);
  if (!running) return;
  if (running.started_at && Date.now() - new Date(running.started_at).getTime() > timeoutMinutes * 60000) {
    await batches.transition(tenant, running.id, BATCH.FAILED, { error: 'Lote sem fim dentro do prazo; processo interrompido.' }, transaction);
    return;
  }
  throw errors.batchRunning(); // já há um lote em execução nesta fonte: o segundo recebe 409 sem esperar o primeiro terminar
}

/** PLANNED -> RUNNING numa transação própria e confirmada: o lote RUNNING é visível às demais conexões (o segundo executor recebe GOV_MIG_BATCH_RUNNING). */
async function openBatch(tenant, runId, source, plan, replayOf, settings) {
  return openTenantTx(tenant, async (transaction) => {
    await releaseStale(tenant, source, settings.timeoutMinutes, transaction);
    const planned = await batches.insert(tenant, { runId, source, fromToken: plan.fromToken, toToken: plan.toToken, replayOf }, transaction);
    return batches.transition(tenant, planned.id, BATCH.RUNNING, {}, transaction);
  });
}

/**
 * Roda um lote (M9-D900 §3.4): abre o lote (RUNNING), aplica numa transação própria e confirma. Falha desfaz o lote inteiro e o checkpoint não avança; o lote vai a FAILED e
 * volta a RUNNING (nova tentativa) até `migracao.lote.max_tentativas` falhas seguidas, quando o executor o leva a ABORTED e interrompe a fonte. Devolve { batch, counts }.
 */
async function runBatch(tenant, actor, runId, source, plan, { replayOf = null, settings }) {
  if (!replayOf) {
    const fresh = await openTenantTx(tenant, (transaction) => sources.get(tenant, source.id, transaction));
    assertNoGap(fresh, plan.fromToken);
  }
  let batch = await openBatch(tenant, runId, source, plan, replayOf, settings);
  for (;;) {
    try {
      return await openTenantTx(tenant, (transaction) => applyBatch(tenant, actor, batch, plan.events, transaction));
    } catch (err) {
      const message = String((err && err.message) || err).slice(0, 500);
      logger.warn({ batchId: batch.id, attempt: batch.attempts, err: message, detail: err && err.parent && err.parent.detail }, 'migration.batch.failed');
      if (batch.attempts >= settings.maxAttempts) {
        await openTenantTx(tenant, (transaction) => batches.transition(tenant, batch.id, BATCH.ABORTED, { error: message }, transaction));
        const aborted = new Error(`Lote abortado após ${batch.attempts} falhas seguidas: ${message}`);
        aborted.code = 'GOV_MIG_BATCH_ABORTED';
        aborted.batchId = batch.id;
        throw aborted;
      }
      await openTenantTx(tenant, (transaction) => batches.transition(tenant, batch.id, BATCH.FAILED, { error: message }, transaction));
      batch = await openTenantTx(tenant, (transaction) => batches.transition(tenant, batch.id, BATCH.RUNNING, {}, transaction));
    }
  }
}

module.exports = { runBatch, loadSettings };
