'use strict';

const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const { getCurrentHealth } = require('../health/healthQuery');
const { effectiveOk } = require('./contingency.recoveryOk');
const { deactivateContingency } = require('./contingency.activate');
const { resolveContingencyPolicy, resolvePolicyFor } = require('./contingency.policy');
const { readContingencyParams } = require('./contingency.params');
const { drainQueue } = require('./contingency.drain');
const { toView } = require('./contingency.state');

/** A connection está recuperada? Circuito CLOSED, ativa, saúde fora de DOWN e `recovery_checks` testes de saúde seguidos OK. */
async function isRecovered(ctx, connection, checks, now, transaction) {
  if (connection.status !== 'ACTIVE') return false;
  const saude = await getCurrentHealth(connection.id, ctx, transaction, { now });
  return effectiveOk(saude, checks);
}

/** Connections ACTIVE do ambiente que pertencem à família (para a contingência sem connection ativa). */
async function activeOfFamily(ctx, domain, transaction) {
  const providers = await IntegrationProvider.findAll({ where: { domain }, attributes: ['code'], transaction });
  return IntegrationConnection.findAll({ where: { companyId: ctx.companyId, status: 'ACTIVE', providerCode: providers.map((p) => p.code) }, transaction });
}

/**
 * Tenta encerrar uma contingência ativa (M9-D226 3.3 item 4). Recuperada: a fila da connection é liberada em ordem de criação (respeitando a cota), o
 * alternativo volta a ser reserva (nada a desfazer: a troca só vale enquanto a contingência está ativa) e `deactivated` é publicado.
 * Devolve { deactivated, drained[] }.
 */
async function tryRecover(ctx, row, now, transaction) {
  const params = await readContingencyParams(ctx, transaction);
  const view = toView(row);
  let alvo = null;
  let policy = null;
  if (row.connectionId) {
    const connection = await IntegrationConnection.findOne({ where: { id: row.connectionId, companyId: ctx.companyId }, transaction });
    if (connection && (await isRecovered(ctx, connection, params.recoveryChecks, now, transaction))) alvo = connection;
    policy = connection ? await resolveContingencyPolicy(ctx, connection, transaction) : null;
  } else {
    for (const c of await activeOfFamily(ctx, view.domain, transaction)) {
      if (await isRecovered(ctx, c, params.recoveryChecks, now, transaction)) { alvo = c; break; }
    }
    policy = await resolvePolicyFor(ctx, { providerCode: alvo ? alvo.providerCode : null, domain: view.domain }, transaction);
  }
  if (!alvo) return { deactivated: false, drained: [] };
  const drained = await drainQueue(ctx, alvo.id, params.drainBatchSize, now, transaction);
  const note = `Recuperação confirmada: circuito fechado e ${params.recoveryChecks} testes de saúde seguidos OK.`;
  const r = await deactivateContingency(ctx, row, note, policy, transaction);
  return { deactivated: r.deactivated, drained };
}

module.exports = { tryRecover };
