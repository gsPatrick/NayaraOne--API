'use strict';

const logger = require('../../../../utils/logger');
const { IntegrationSyncCursor, IntegrationConnection } = require('../../../../models');
const { getSyncRunner } = require('../../sync/sync.runners');
const { ORIGINS } = require('../../sync/sync.constants');
const { auditarCursor, visao } = require('../../sync/sync.audit');
const { tenantTx } = require('../../sync/sync.tx');
const { settleRetryingErrors } = require('../../errors/errors.settle');
const { notAllowed } = require('./retry.errors');

/**
 * Retry de um erro SYNC (M9-D250 3.1 item 4): zera `consecutive_failures` do fluxo (a única saída de um fluxo STALLED, M9-D208) e deixa um ciclo para rodar DEPOIS do commit
 * (o ciclo tem transações próprias e travaria na linha do cursor). O executor do fluxo é quem registrou em `registerSyncRunner`; sem ele o retry é recusado.
 * Devolve { cursorId, afterCommit }: afterCommit roda o ciclo com a origem HUMAN_RETRY e fecha o erro (fluxo voltou a IDLE: RESOLVED; senão volta a OPEN).
 */
async function retrySyncError(ctx, error, _body, _params, transaction) {
  const cursor = error.financingCaseId
    ? await IntegrationSyncCursor.findOne({ where: { id: error.financingCaseId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE })
    : null;
  if (!cursor) throw notAllowed({ reason: 'SYNC_CURSOR_NOT_FOUND' });
  if (!['FAILED', 'STALLED'].includes(cursor.status)) throw notAllowed({ cursorStatus: cursor.status });
  const runner = getSyncRunner(cursor.stream);
  if (!runner) throw notAllowed({ reason: 'SYNC_RUNNER_NOT_REGISTERED', stream: cursor.stream });
  const connection = await IntegrationConnection.findOne({ where: { id: cursor.connectionId, companyId: ctx.companyId }, transaction });
  if (!connection || connection.status !== 'ACTIVE') throw notAllowed({ reason: 'CONNECTION_NOT_ACTIVE' });
  const antes = visao(cursor);
  cursor.consecutiveFailures = 0;
  if (cursor.status === 'STALLED') cursor.status = 'FAILED'; // sai de STALLED: o agendador também volta a rodar o fluxo
  await cursor.save({ transaction });
  await auditarCursor(ctx, antes, cursor, 'Retry humano autorizado: falhas seguidas zeradas.', transaction);
  const { stream } = cursor;
  const alvo = { id: connection.id, providerCode: connection.providerCode, environment: connection.environment };
  const cursorId = cursor.id;
  const plain = { groupId: ctx.groupId, companyId: ctx.companyId, userId: ctx.userId };
  const afterCommit = async () => {
    let ok = false;
    try {
      await runner({ ctx: plain, connection: alvo, stream, origin: ORIGINS.HUMAN_RETRY });
      ok = true;
    } catch (err) {
      logger.warn({ cursorId, err: err.message }, 'Retry humano do fluxo: o ciclo não pôde rodar.');
    }
    await tenantTx(plain, async (t) => {
      const depois = await IntegrationSyncCursor.findByPk(cursorId, { transaction: t });
      if (ok && depois && depois.status === 'IDLE') await settleRetryingErrors(plain, cursorId, 'RESOLVED', t, 'O ciclo de sincronização repetido terminou sem falha.');
      else await settleRetryingErrors(plain, cursorId, 'OPEN', t);
    });
  };
  return { cursorId, afterCommit };
}

module.exports = { retrySyncError };
