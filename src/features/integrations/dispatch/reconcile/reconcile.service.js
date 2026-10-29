'use strict';

const { Op } = require('sequelize');
const logger = require('../../../../utils/logger');
const { IntegrationDispatch, IntegrationConnection } = require('../../../../models');
const adapterRegistry = require('../../registry/adapterRegistry');
const { portOperation } = require('../enqueue/resolveTarget');
const { tenantTx } = require('../worker/tenantTx');
const { readWorkerParams } = require('../worker/worker.params');
const { resolveEffectivePolicy } = require('../retry/retry.policy');
const { readRetryParams } = require('../retry/retry.params');
const { readReconcileParams, waitBeforeAttemptS } = require('./reconcile.params');
const { runStrategies, FOUND, NOT_FOUND } = require('./reconcile.lookup');
const { view, applyFound, applyNotFound, applyInconclusive, applySafeRetry, recordOutcome } = require('./reconcile.apply');

const lockRow = (ctx, id, transaction) => IntegrationDispatch.findOne({ where: { id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });

/** A consulta do envio em UNKNOWN está devida? Sem data marcada, vale a espera antes da 1ª consulta a partir de unknown_since. */
function isDue(row, params, now) {
  const quando = row.nextAttemptAt || (row.unknownSince ? new Date(row.unknownSince.getTime() + waitBeforeAttemptS(params, row.reconcileAttempts) * 1000) : null);
  return !quando || quando.getTime() <= now.getTime();
}

/** Resolve o adapter e o port do envio; devolve { adapter, port, statusDef } ou { failure } (connection parada ou sem adapter). */
async function resolveTools(ctx, row, transaction) {
  const connection = await IntegrationConnection.findOne({ where: { id: row.connectionId, companyId: ctx.companyId }, transaction });
  if (!connection) return { failure: 'CONNECTION_MISSING' };
  if (connection.status !== 'ACTIVE') return { failure: `CONNECTION_${connection.status}`, parked: true, connection };
  const { Port, def } = await portOperation(row.providerCode, row.operation, transaction);
  if (!def || !def.reconcileStrategy) return { failure: 'NO_RECONCILE_STRATEGY', connection };
  let adapter;
  try { adapter = await adapterRegistry.resolve(connection, ctx, transaction); } catch { return { failure: 'ADAPTER_UNAVAILABLE', connection }; }
  const statusDef = def.reconcileStrategy.status ? Port.operations[def.reconcileStrategy.status] : null;
  return { adapter, port: { domain: Port.domain, reconcileStrategy: def.reconcileStrategy }, statusDef, connection };
}

/**
 * reconcileDispatch — uma consulta ao fornecedor sobre UM envio em UNKNOWN (M9-D215 3.2). Trava a linha (FOR UPDATE), RELÊ o status (webhook e
 * consulta simultâneos: o primeiro a confirmar vence, o segundo vê o estado final e não faz nada) e decide pelo resultado: achou ->
 * CONFIRMED, FAILED ou SUBMITTED; "não existe" -> RETRY_WAIT com a mesma chave; inconclusivo -> segue UNKNOWN até esgotar as consultas.
 * Operação SAFE não consulta: repete com backoff. `opts.onlyIfDue`: o job só consulta quando a espera passou.
 */
async function reconcileDispatch(ctx, id, { now = new Date(), onlyIfDue = false } = {}) {
  return tenantTx(ctx, async (transaction) => {
    const row = await lockRow(ctx, id, transaction);
    if (!row || row.status !== 'UNKNOWN') return { skipped: true, status: row ? row.status : null };
    const params = await readReconcileParams(ctx, transaction);
    if (onlyIfDue && !isDue(row, params, now)) return { skipped: true, status: row.status, notDue: true };
    const before = view(row);
    const tools = await resolveTools(ctx, row, transaction);
    if (row.criticalityOp === 'SAFE') {
      const policy = tools.connection ? await resolveEffectivePolicy(ctx, tools.connection, transaction) : { retry: await readRetryParams(ctx, transaction) };
      const r = await applySafeRetry(ctx, row, { now, policy }, transaction);
      await recordOutcome(ctx, before, r, { verdict: 'SAFE_RETRY', trail: [], source: 'RECONCILE' }, transaction);
      return { status: r.state, verdict: 'SAFE_RETRY' };
    }
    if (tools.parked) {
      // Integração parada (pausada, desativada ou credencial recusada): espera sem gastar consulta, como o worker faz com os envios.
      const { blockedRecheckS } = await readWorkerParams(ctx, transaction);
      await row.update({ nextAttemptAt: new Date(now.getTime() + blockedRecheckS * 1000) }, { transaction });
      return { status: 'UNKNOWN', verdict: 'PARKED', reason: tools.failure };
    }
    let verdict = 'INCONCLUSIVE';
    let found = null;
    let trail = [{ strategy: 'ALL', outcome: 'ERROR', code: tools.failure || 'NONE' }];
    if (!tools.failure) ({ verdict, found, trail } = await runStrategies({ ctx, dispatch: row, adapter: tools.adapter, port: tools.port, statusDef: tools.statusDef, transaction }));
    // Contradição: o envio já tem id externo e o fornecedor diz que não há registro (ou a consulta não achou): nunca repete, vai para conferência.
    if (verdict === NOT_FOUND && row.externalResourceId) { verdict = 'INCONCLUSIVE'; trail = [...trail, { strategy: 'GUARD', outcome: 'EXTERNAL_ID_REGISTERED' }]; }
    let r;
    if (verdict === FOUND) r = await applyFound(ctx, row, found, { source: 'STATUS_QUERY' }, transaction);
    else if (verdict === NOT_FOUND) r = await applyNotFound(ctx, row, { now }, transaction);
    else r = await applyInconclusive(ctx, row, { now, params, trail }, transaction);
    await recordOutcome(ctx, before, r, { verdict, trail, source: 'RECONCILE' }, transaction);
    return { status: r.state, verdict, trail };
  });
}

/**
 * reconcileDue — a rodada do job para UMA empresa: os envios em UNKNOWN com a consulta devida (até `limit`), cada um na sua transação; a
 * falha de um não derruba os outros. Devolve { due, reconciled, errors }.
 */
async function reconcileDue(ctx, { now = new Date(), limit = 50 } = {}) {
  const ids = await tenantTx(ctx, async (transaction) => {
    const params = await readReconcileParams(ctx, transaction);
    const rows = await IntegrationDispatch.findAll({
      where: { companyId: ctx.companyId, status: 'UNKNOWN', [Op.or]: [{ nextAttemptAt: { [Op.lte]: now } }, { nextAttemptAt: null }] },
      attributes: ['id', 'nextAttemptAt', 'unknownSince', 'reconcileAttempts'], order: [['unknown_since', 'ASC']], limit: Math.max(1, Math.min(limit, 500)), transaction,
    });
    return rows.filter((r) => isDue(r, params, now)).map((r) => r.id);
  });
  const summary = { due: ids.length, reconciled: 0, errors: 0 };
  for (const id of ids) {
    try {
      const r = await reconcileDispatch(ctx, id, { now, onlyIfDue: true });
      if (!r.skipped) summary.reconciled += 1;
    } catch (err) {
      summary.errors += 1;
      logger.error({ dispatchId: id, err: err.message }, 'Falha ao reconciliar o envio; ele segue em UNKNOWN.');
    }
  }
  return summary;
}

module.exports = { reconcileDispatch, reconcileDue, isDue, lockRow };
