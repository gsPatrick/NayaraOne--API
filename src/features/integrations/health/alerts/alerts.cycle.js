'use strict';

const { Op } = require('sequelize');
const logger = require('../../../../utils/logger');
const { sequelize, IntegrationConnection, IntegrationProvider, IntegrationSyncCursor } = require('../../../../models');
const { tenantTx } = require('../../dispatch/worker/tenantTx');
const { detectStalledSyncs } = require('../../sync/sync.stalled');
const { readAlertParams } = require('./alerts.params');
const { evaluateConnectionConditions } = require('./alerts.conditions');
const { reconcileConnection, resolveOrphans } = require('./alerts.reconcile');
const { EVALUATED_STATUSES } = require('./alerts.constants');

/**
 * Fluxos parados da empresa: os que o detector da M9-D208 acusa agora (sem sucesso além do limite da criticidade, e que publica o
 * evento integration.sync.stalled uma vez por atraso) mais os que já estão em STALLED por falhas seguidas. Agrupados por connection.
 */
async function stalledByConnection(ctx, now, transaction) {
  const achados = await detectStalledSyncs(ctx, transaction, { now });
  const porId = new Map(achados.map((a) => [a.cursorId, a]));
  const parados = await IntegrationSyncCursor.findAll({ where: { companyId: ctx.companyId, status: 'STALLED' }, transaction });
  for (const c of parados) {
    if (!porId.has(c.id)) porId.set(c.id, { cursorId: c.id, connectionId: c.connectionId, stream: c.stream, reason: 'FAILURES', minutesWithoutSuccess: null, limitMinutes: null });
  }
  const mapa = new Map();
  for (const s of porId.values()) mapa.set(s.connectionId, [...(mapa.get(s.connectionId) || []), s]);
  return mapa;
}

/**
 * Uma rodada de avaliação dos alertas para UMA empresa (M9-D224): cada connection ACTIVE ou AUTH_FAILED é avaliada e conciliada num
 * savepoint (a falha de uma não derruba as outras). Devolve { connections, opened, renotified, resolved, errors }.
 */
async function runAlertCycle(ctx, { now = new Date() } = {}) {
  return tenantTx(ctx, async (transaction) => {
    const params = await readAlertParams(ctx, transaction);
    const stalls = await stalledByConnection(ctx, now, transaction);
    const conexoes = await IntegrationConnection.findAll({ where: { companyId: ctx.companyId, status: { [Op.in]: EVALUATED_STATUSES } }, order: [['created_at', 'ASC'], ['id', 'ASC']], transaction });
    const dominios = new Map((await IntegrationProvider.findAll({ attributes: ['code', 'domain'], transaction })).map((p) => [p.code, p.domain]));
    const resumo = { connections: 0, opened: 0, renotified: 0, resolved: 0, errors: 0 };
    for (const connection of conexoes) {
      try {
        await sequelize.transaction({ transaction }, async (sp) => {
          const domain = dominios.get(connection.providerCode) || null;
          const conditions = await evaluateConnectionConditions(connection, ctx, { now, params, stalls: stalls.get(connection.id) || [], domain }, sp);
          const r = await reconcileConnection({ connection, ctx, conditions, params, now }, sp);
          ['opened', 'renotified', 'resolved'].forEach((k) => { resumo[k] += r[k]; });
        });
        resumo.connections += 1;
      } catch (err) {
        resumo.errors += 1;
        logger.error({ connectionId: connection.id, err: err.message }, 'Alertas de integração: falha ao avaliar a connection.');
      }
    }
    resumo.resolved += await resolveOrphans(ctx, new Set(conexoes.map((c) => c.id)), now, transaction);
    return resumo;
  });
}

module.exports = { runAlertCycle, stalledByConnection };
