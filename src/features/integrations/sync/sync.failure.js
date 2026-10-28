'use strict';

const { IntegrationSyncCursor } = require('../../../models');
const { publishDomainEvent } = require('../../../engines/events/outbox');
const { auditarCursor, visao } = require('./sync.audit');
const { agoraDoBanco } = require('./sync.lease');
const { STALLED_EVENT, ENTITY_TYPE } = require('./sync.constants');
const { tenantTx } = require('./sync.tx');
const { recordSyncError } = require('./sync.errors');

const codigoDe = (err) => (typeof err?.code === 'string' && err.code ? err.code : 'SYNC_CYCLE_FAILED').slice(0, 64);

/** Dado do alerta SYNC_STALLED (D224 transforma o evento em alerta). Só ids e contagens: nada do corpo do provider. */
function eventoParado(cursor, conexao, motivo, chaveTempo) {
  return {
    groupId: cursor.groupId,
    companyId: cursor.companyId,
    aggregateType: ENTITY_TYPE,
    aggregateId: cursor.id,
    eventType: STALLED_EVENT,
    payload: {
      cursorId: cursor.id, connectionId: cursor.connectionId, providerCode: conexao.providerCode, stream: cursor.stream,
      reason: motivo, consecutiveFailures: cursor.consecutiveFailures, lastSuccessAt: cursor.lastSuccessAt, lastErrorCode: cursor.lastErrorCode,
    },
    idempotencyKey: `${STALLED_EVENT}:${cursor.id}:${motivo}:${chaveTempo}`,
  };
}

/**
 * Falha do ciclo: conta, marca FAILED (ou STALLED ao atingir o limite), libera o lease, audita e registra o erro.
 * A página que falhou já reverteu inteira. Se o lease foi assumido por outro worker, esta linha não é mais nossa e nada muda.
 */
async function registerFailure({ cursorId, workerId, err, conexao, stream, recordError = recordSyncError }, ctx, params) {
  return tenantTx(ctx, async (transaction) => {
    const cursor = await IntegrationSyncCursor.findByPk(cursorId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!cursor || cursor.leaseOwner !== workerId) return { status: 'LEASE_LOST', errorCode: codigoDe(err) };
    const antes = visao(cursor);
    const agora = await agoraDoBanco(transaction);
    cursor.consecutiveFailures += 1;
    cursor.lastErrorCode = codigoDe(err);
    cursor.status = cursor.consecutiveFailures >= params.failuresToStall ? 'STALLED' : 'FAILED';
    cursor.leaseOwner = null;
    cursor.leaseExpiresAt = null;
    await cursor.save({ transaction });
    await auditarCursor(ctx, antes, cursor, cursor.status === 'STALLED' ? `Fluxo parado após ${cursor.consecutiveFailures} falhas seguidas.` : 'Falha no ciclo de sincronização.', transaction);
    await recordError({ ctx, cursorId: cursor.id, connection: conexao, stream, errorCode: cursor.lastErrorCode, consecutiveFailures: cursor.consecutiveFailures }, transaction);
    if (cursor.status === 'STALLED') {
      await publishDomainEvent(eventoParado(cursor, conexao, 'FAILURES', agora.getTime()), transaction);
    }
    return { status: cursor.status, errorCode: cursor.lastErrorCode };
  });
}

module.exports = { registerFailure, eventoParado, codigoDe };
