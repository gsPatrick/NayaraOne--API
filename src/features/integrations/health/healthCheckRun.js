'use strict';

const crypto = require('crypto');
const logger = require('../../../utils/logger');
const { IntegrationConnection } = require('../../../models');
const adapterRegistry = require('../registry/adapterRegistry');
const { runHealthCheck } = require('../registry/adapterHealth');
const { readAdapterParams } = require('../registry/adapters.params');
const { recordError } = require('../errors');
const { tenantTx } = require('../dispatch/worker/tenantTx');
const { peekCircuit } = require('./circuitPeek');
const { ensureCurrentRow } = require('./healthStore');
const { acquireLease, releaseLease } = require('./healthCheckLease');
const { recordHealthCheck } = require('./healthRecorder');
const { readHealthParams } = require('./healthParams');

const MENSAGEM_FORA_DO_AR = (n) => `O fornecedor não respondeu a ${n} testes de saúde seguidos: a integração foi marcada como fora do ar.`;

/** Fase 1 (commit antes da chamada): a connection, o circuito e o lease. Devolve { skipped } ou { connection, owner }. */
async function prepare(ctx, connectionId, now) {
  return tenantTx(ctx, async (transaction) => {
    const connection = await IntegrationConnection.findOne({ where: { id: connectionId, companyId: ctx.companyId }, transaction });
    if (!connection) return { skipped: 'CONNECTION_MISSING' };
    if (connection.status !== 'ACTIVE') return { skipped: `CONNECTION_${connection.status}` };
    const circuito = await peekCircuit(connection, ctx, transaction, { now });
    if (!circuito.allowed) return { skipped: circuito.reason };
    const { healthCheckTimeoutMs } = await readAdapterParams(ctx, transaction);
    await ensureCurrentRow(connection, now, transaction);
    const owner = crypto.randomUUID();
    if (!(await acquireLease(connection.id, owner, new Date(now.getTime() + healthCheckTimeoutMs * 2), now, transaction))) return { skipped: 'LEASE_HELD' };
    return { connection, owner };
  });
}

/** Alerta HIGH PROVIDER_DOWN quando as falhas seguidas chegam ao limite (o painel e a notificação são da M9-D224). */
async function reportDown(ctx, connection, row, params, transaction) {
  if (Number(row.check_consecutive_failures) < params.downAfterFailures) return;
  await recordError(ctx, {
    providerCode: connection.providerCode, connectionId: connection.id, source: 'HEALTH', errorClass: 'TRANSIENT', errorCode: 'PROVIDER_DOWN', severity: 'HIGH',
    message: MENSAGEM_FORA_DO_AR(row.check_consecutive_failures), attempts: Number(row.check_consecutive_failures),
  }, transaction);
}

/** Fase 2: chama o teste de saúde do adapter (nunca lança), grava o resultado e devolve o lease. */
async function check(ctx, connection, owner) {
  return tenantTx(ctx, async (transaction) => {
    let resultado;
    try {
      const adapter = await adapterRegistry.resolve(connection, ctx, transaction);
      resultado = await runHealthCheck(adapter, ctx, transaction);
    } catch (err) {
      resultado = { ok: false, latencyMs: 0, detail: 'adaptador indisponível' };
    }
    const params = await readHealthParams(ctx, transaction);
    const row = await recordHealthCheck(connection.id, { ok: resultado.ok, latencyMs: resultado.latencyMs, at: new Date(), quota: resultado.quota }, transaction);
    if (!resultado.ok) await reportDown(ctx, connection, row, params, transaction);
    await releaseLease(connection.id, owner, transaction);
    return { status: 'CHECKED', ok: resultado.ok, latencyMs: resultado.latencyMs, detail: resultado.detail, healthStatus: row.health_status };
  });
}

/**
 * Teste de saúde ativo de UMA connection (M9-D223 3.1). Nunca lança: o resultado é { status: 'CHECKED', ok, latencyMs, detail } ou
 * { status: 'SKIPPED', reason } (connection inexistente ou parada, HALF_OPEN sem vaga, lease de outro teste). O circuito é só lido.
 */
async function runConnectionHealthCheck(ctx, connectionId, { now = new Date() } = {}) {
  let preparo;
  try {
    preparo = await prepare(ctx, connectionId, now);
  } catch (err) {
    logger.warn({ connectionId, err: err.message }, 'Teste de saúde: não foi possível preparar.');
    return { status: 'SKIPPED', reason: 'PREPARE_FAILED' };
  }
  if (preparo.skipped) return { status: 'SKIPPED', reason: preparo.skipped };
  try {
    return await check(ctx, preparo.connection, preparo.owner);
  } catch (err) {
    logger.warn({ connectionId, err: err.message }, 'Teste de saúde: falha ao gravar o resultado; o lease vence sozinho.');
    await tenantTx(ctx, (transaction) => releaseLease(connectionId, preparo.owner, transaction)).catch(() => null);
    return { status: 'SKIPPED', reason: 'RECORD_FAILED' };
  }
}

module.exports = { runConnectionHealthCheck };
