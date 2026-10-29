'use strict';

const { IntegrationDispatch, IntegrationConnection } = require('../../../../models');
const adapterRegistry = require('../../registry/adapterRegistry');
const { invoke } = require('../../registry/adapterInvoke');
const { portOperation } = require('../enqueue/resolveTarget');
const { readWorkerParams } = require('./worker.params');
const { tenantTx } = require('./tenantTx');
const { runPreflight } = require('./worker.preflight');
const { deferDispatch } = require('./worker.defer');
const { startAttempt } = require('./worker.attempts');
const { handleSuccess } = require('./worker.success');
const { handleFailure } = require('./worker.failure');
const { getCallObservers } = require('./worker.hooks');

const lockSending = (ctx, id, transaction) => IntegrationDispatch.findOne({ where: { id, companyId: ctx.companyId, status: 'SENDING' }, transaction, lock: transaction.LOCK.UPDATE });

/** Fase A (tx curta): relê a conexão, aplica as esperas e abre a tentativa. Devolve { attemptId } ou { deferred }. */
async function phaseA(ctx, id, now) {
  return tenantTx(ctx, async (transaction) => {
    const dispatch = await lockSending(ctx, id, transaction);
    if (!dispatch) return { skipped: true };
    const connection = await IntegrationConnection.findOne({ where: { id: dispatch.connectionId, companyId: ctx.companyId }, transaction });
    const params = await readWorkerParams(ctx, transaction);
    const verdict = await runPreflight({ ctx, dispatch, connection, now, params, transaction });
    if (verdict) {
      await deferDispatch(ctx, dispatch, verdict.until, verdict.reason, transaction);
      return { deferred: verdict.reason };
    }
    return { attemptId: await startAttempt(ctx, dispatch, now, transaction) };
  });
}

/** Observadores da resposta (cota do fornecedor): nunca derrubam o envio. */
async function observe(args) {
  for (const fn of getCallObservers()) {
    try { await fn(args); } catch { /* observar não pode quebrar o envio */ }
  }
}

/** Fase B (tx da chamada): resolve o adapter, chama pelo contrato, e grava sucesso ou falha. O commit de SENDING já aconteceu. */
async function phaseB(ctx, id, attemptId, now) {
  return tenantTx(ctx, async (transaction) => {
    const dispatch = await lockSending(ctx, id, transaction);
    if (!dispatch) return { skipped: true };
    const connection = await IntegrationConnection.findOne({ where: { id: dispatch.connectionId, companyId: ctx.companyId }, transaction });
    const { def } = await portOperation(dispatch.providerCode, dispatch.operation, transaction);
    let adapter = null;
    const inicio = Date.now();
    try {
      adapter = await adapterRegistry.resolve(connection, ctx, transaction);
    } catch (error) {
      const classification = { class: 'VALIDATION', code: error.code || 'INTEGRATION_ADAPTER_UNAVAILABLE' };
      await handleFailure({ ctx, dispatch, def, adapter, error, classification, attemptId, latencyMs: 0, now, transaction });
      return { failed: classification };
    }
    const meta = { dispatchId: dispatch.id, attempt: dispatch.attempts, idempotencyKey: adapter.supportsIdempotency(dispatch.operation) ? dispatch.idempotencyKey : undefined };
    let normalized;
    try {
      normalized = await invoke(adapter, dispatch.operation, dispatch.payloadSnapshot, { tenant: ctx, transaction, meta });
    } catch (error) {
      const latencyMs = Date.now() - inicio;
      await observe({ ctx, dispatch, connection, adapter, error, attemptId, now, transaction });
      await handleFailure({ ctx, dispatch, def, adapter, error, attemptId, latencyMs, now, transaction });
      return { failed: true };
    }
    await observe({ ctx, dispatch, connection, adapter, response: normalized, attemptId, now, transaction });
    await handleSuccess({ ctx, dispatch, def, normalized, attemptId, latencyMs: Date.now() - inicio, transaction });
    return { ok: true };
  });
}

/** Processa UM envio já pego (SENDING): fase A e, se liberado, fase B. */
async function processClaimed(ctx, id, { now = new Date() } = {}) {
  const a = await phaseA(ctx, id, now);
  if (a.skipped || a.deferred) return a;
  return phaseB(ctx, id, a.attemptId, now);
}

module.exports = { processClaimed };
