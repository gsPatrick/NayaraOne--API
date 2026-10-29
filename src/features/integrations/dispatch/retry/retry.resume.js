'use strict';

const { IntegrationDispatch } = require('../../../../models');
const { applyTransition } = require('../dispatch.transition');

/**
 * Connection voltou de AUTH_FAILED por test-connection verde (D250): os envios que pararam por recusa de credencial voltam a
 * RETRY_WAIT para agora, SEM gastar tentativa (o contador não é zerado nem consumido) e com a renovação automática liberada de novo.
 * Os que esperavam em RETRY_WAIT ou PENDING seguem sozinhos: o worker só os pegava de volta quando a connection ficou ACTIVE.
 */
async function resumeAuthFailedDispatches(ctx, connectionId, transaction) {
  const parados = await IntegrationDispatch.findAll({
    where: { connectionId, companyId: ctx.companyId, status: 'FAILED', lastErrorClass: 'AUTH' }, order: [['created_at', 'ASC']],
    transaction, lock: transaction.LOCK.UPDATE, skipLocked: true,
  });
  const out = [];
  for (const row of parados) {
    out.push(await applyTransition(ctx, row, 'RETRY_WAIT', { nextAttemptAt: new Date(), authRenewals: 0 }, { authRecovery: true, motivo: 'Integração reativada: envio retomado sem gastar tentativa.' }, transaction));
  }
  return out;
}

module.exports = { resumeAuthFailedDispatches };
