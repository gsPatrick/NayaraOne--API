'use strict';

const { IntegrationSyncCursor } = require('../../../models');
const { auditarCursor, visao } = require('./sync.audit');
const { agoraDoBanco } = require('./sync.lease');
const { tenantTx } = require('./sync.tx');

/** Passo (e): ciclo completo. Volta a IDLE, zera as falhas, libera o lease e registra o último sucesso. */
async function finishSuccess({ cursorId, workerId }, ctx) {
  return tenantTx(ctx, async (transaction) => {
    const cursor = await IntegrationSyncCursor.findByPk(cursorId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!cursor || cursor.leaseOwner !== workerId) return null;
    const antes = visao(cursor);
    const agora = await agoraDoBanco(transaction);
    cursor.status = 'IDLE';
    cursor.leaseOwner = null;
    cursor.leaseExpiresAt = null;
    cursor.lastSuccessAt = agora;
    cursor.lastErrorCode = null;
    cursor.consecutiveFailures = 0;
    await cursor.save({ transaction });
    await auditarCursor(ctx, antes, cursor, 'Ciclo de sincronização concluído.', transaction);
    return cursor.toJSON();
  });
}

module.exports = { finishSuccess };
