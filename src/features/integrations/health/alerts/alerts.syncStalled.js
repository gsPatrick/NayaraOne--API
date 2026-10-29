'use strict';

const { IntegrationConnection, IntegrationProvider } = require('../../../../models');
const { effectiveCriticality } = require('../../providers/catalog.service');
const { readSyncParams } = require('../../sync/sync.params');
const { registerEventConsumer } = require('../../../../engines/events/consumers');
const { STALLED_EVENT } = require('../../sync/sync.constants');
const { runbookPathFor } = require('../runbooks');
const { readAlertParams } = require('./alerts.params');
const store = require('./alerts.store');
const { notifyAlert } = require('./alerts.notify');

const CONSUMER_NAME = 'integration-alert-sync-stalled';

/**
 * Consumidor do evento `integration.sync.stalled` (M9-D208 publica, M9-D224 converte em alerta): abre o alerta SYNC_STALLED do fluxo
 * assim que o atraso é detectado, sem esperar a próxima rodada. Idempotente (a chave do alerta é o cursor) e sem repetir aviso: a
 * repetição, depois de `repeat_min`, e a resolução no sucesso seguinte são da rodada de alertas.
 */
/** O limite de minutos sem sucesso da criticidade da família da connection (M9-D208: CRITICAL 15, HIGH 30, MEDIUM 120, LOW 1440, em parâmetros). */
async function limitOf(connection, ctx, transaction) {
  const provider = await IntegrationProvider.findByPk(connection.providerCode, { attributes: ['code', 'domain'], transaction });
  const criticality = provider ? await effectiveCriticality(provider.domain, ctx, transaction) : null;
  const params = await readSyncParams(ctx, transaction);
  return { criticality, limitMinutes: criticality ? params.stalledAfterMinutes[criticality] : null };
}

async function onSyncStalled(event, transaction) {
  const p = event.payloadJson || {};
  const ctx = { groupId: event.groupId, companyId: event.companyId };
  const connection = p.connectionId ? await IntegrationConnection.findOne({ where: { id: p.connectionId, companyId: ctx.companyId }, transaction }) : null;
  if (!connection || connection.status !== 'ACTIVE') return null;
  const { criticality, limitMinutes } = await limitOf(connection, ctx, transaction);
  const desde = p.lastSuccessAt ? new Date(p.lastSuccessAt).getTime() : null;
  const condition = {
    type: 'SYNC_STALLED', marker: String(p.cursorId), severity: 'HIGH',
    details: {
      stream: p.stream, reason: p.reason || 'NO_SUCCESS', criticality, limitMinutes,
      minutesWithoutSuccess: desde === null ? null : Math.floor(((event.occurredAt ? new Date(event.occurredAt).getTime() : Date.now()) - desde) / 60000),
    },
  };
  const novo = await store.insertOpen({ connection, condition, runbookPath: runbookPathFor(connection.providerCode), now: new Date() }, transaction);
  if (!novo) return null;
  const params = await readAlertParams(ctx, transaction);
  await notifyAlert(ctx, { ...novo, details: condition.details }, 'OPEN', params.notifyRoles, transaction);
  await store.markNotified(novo.id, condition, new Date(), transaction);
  return novo;
}

registerEventConsumer(STALLED_EVENT, CONSUMER_NAME, onSyncStalled);

module.exports = { onSyncStalled, CONSUMER_NAME };
