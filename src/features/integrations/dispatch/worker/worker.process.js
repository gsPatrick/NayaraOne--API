'use strict';

const { sequelize, IntegrationDispatch, IntegrationConnection } = require('../../../../models');
const adapterRegistry = require('../../registry/adapterRegistry');
const { invoke } = require('../../registry/adapterInvoke');
const { portOperation } = require('../enqueue/resolveTarget');
const { readWorkerParams } = require('./worker.params');
const { tenantTx } = require('./tenantTx');
const { runPreflight } = require('./worker.preflight');
const { applyVerdict } = require('./worker.verdict');
const { startAttempt } = require('./worker.attempts');
const { handleSuccess } = require('./worker.success');
const { handleFailure } = require('./worker.failure');
const { getCallObservers } = require('./worker.hooks');
const { admitCall, recordCallResult } = require('../../health/circuitBreaker');

const lockSending = (ctx, id, transaction) => IntegrationDispatch.findOne({ where: { id, companyId: ctx.companyId, status: 'SENDING' }, transaction, lock: transaction.LOCK.UPDATE });

/** Fase A (tx curta): relê a conexão, aplica as esperas e abre a tentativa. Devolve { attemptId } ou { deferred }. */
async function phaseA(ctx, id, now, run = tenantTx) {
  return run(ctx, async (transaction) => {
    const dispatch = await lockSending(ctx, id, transaction);
    if (!dispatch) return { skipped: true };
    const connection = await IntegrationConnection.findOne({ where: { id: dispatch.connectionId, companyId: ctx.companyId }, transaction });
    const params = await readWorkerParams(ctx, transaction);
    const verdict = await runPreflight({ ctx, dispatch, connection, now, params, transaction });
    if (verdict) return applyVerdict(ctx, dispatch, verdict, transaction);
    // Circuito (M9-D217): por último, porque admitir um teste do HALF_OPEN ocupa uma vaga. Essencial = marcado no envio (definido pela operação do port).
    const circuito = await admitCall(connection, ctx, transaction, { essential: dispatch.essential === true, now });
    if (!circuito.allowed) {
      return applyVerdict(ctx, dispatch, circuito, transaction);
    }
    return { attemptId: await startAttempt(ctx, dispatch, now, transaction), probe: circuito.probe };
  });
}

/** Observadores da resposta (cota do fornecedor): nunca derrubam o envio. */
async function observe(args) {
  for (const fn of getCallObservers()) {
    try { await fn(args); } catch { /* observar não pode quebrar o envio */ }
  }
}

/** Fase B (tx da chamada): resolve o adapter, chama pelo contrato, e grava sucesso ou falha. O commit de SENDING já aconteceu. */
async function phaseB(ctx, id, attemptId, now, probe = false, run = tenantTx) {
  return run(ctx, async (transaction) => {
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
      await handleFailure({ ctx, dispatch, connection, probe, def, adapter, error, classification, attemptId, latencyMs: 0, now, transaction });
      return { failed: classification };
    }
    // `transaction`: adapters que precisam ler dados da empresa para montar o pedido (documento e contatos do Jurídico) o fazem na transação do worker, sob RLS (M9-D236).
    const meta = { dispatchId: dispatch.id, attempt: dispatch.attempts, idempotencyKey: adapter.supportsIdempotency(dispatch.operation) ? dispatch.idempotencyKey : undefined, transaction, tenant: ctx };
    let normalized;
    let bruta = null;
    try {
      normalized = await invoke(adapter, dispatch.operation, dispatch.payloadSnapshot, { tenant: ctx, transaction, meta, onResponse: (r) => { bruta = r; } });
    } catch (error) {
      const latencyMs = Date.now() - inicio;
      await observe({ ctx, dispatch, connection, adapter, error, attemptId, now, transaction });
      await handleFailure({ ctx, dispatch, connection, probe, def, adapter, error, attemptId, latencyMs, now, transaction });
      return { failed: true, error };
    }
    await observe({ ctx, dispatch, connection, adapter, response: bruta || normalized, attemptId, now, transaction });
    await handleSuccess({ ctx, dispatch, def, adapter, normalized, attemptId, latencyMs: Date.now() - inicio, transaction });
    await recordCallResult(connection, ctx, transaction, { ok: true, probe, now });
    return { ok: true };
  });
}

/** Processa UM envio já pego (SENDING): fase A e, se liberado, fase B. */
async function processClaimed(ctx, id, { now = new Date(), transaction = null } = {}) {
  // Com `transaction` (M9-D240: fluxo do Correspondente dentro da transação do pedido) as duas fases rodam nela; sem, cada fase abre a sua.
  const run = transaction ? (_ctx, fn) => sequelize.transaction({ transaction }, fn) : tenantTx; // savepoint: a falha de uma fase não aborta a transação do pedido
  const a = await phaseA(ctx, id, now, run);
  if (a.skipped || a.deferred || a.failed) return a;
  return phaseB(ctx, id, a.attemptId, now, a.probe, run);
}

module.exports = { processClaimed };
