'use strict';

const AppError = require('../../../utils/AppError');
const { IntegrationDispatch } = require('../../../models');
const { transitionDispatch } = require('./dispatch.transition');
const { retryNotAllowed, alreadyConfirmed } = require('./dispatch.errors');
const { RETRY_PERMISSION } = require('./dispatch.constants');

const temPermissao = (ctx) => {
  const p = ctx && ctx.permissions;
  if (!p) return false;
  return (p instanceof Set ? p.has(RETRY_PERMISSION) : Array.isArray(p) && p.includes(RETRY_PERMISSION));
};

/**
 * retryDispatchManually — retry HUMANO de um envio FAILED ou DEAD_LETTER (executor com `integration:retry`). Reabre o mesmo
 * envio (sem nova chave nem novo hash) em RETRY_WAIT; de DEAD_LETTER soma 3 em max_attempts e mantém attempts.
 * A rota e o motivo obrigatório são da M9-D250.
 */
async function retryDispatchManually(ctx, id, transaction) {
  if (!temPermissao(ctx)) throw AppError.forbidden('Você não tem permissão para repetir envios.', 'PERMISSION_DENIED', { required: RETRY_PERMISSION });
  // Erro de VALIDATION é permanente (M9-D216): repetir o mesmo conteúdo dá o mesmo erro; a correção nasce como outro envio.
  const atual = await IntegrationDispatch.findOne({ where: { id, companyId: ctx.companyId }, attributes: ['status', 'lastErrorClass'], transaction });
  if (atual && atual.status === 'CONFIRMED') throw alreadyConfirmed(); // M9-D215: o fornecedor já executou; repetir duplicaria a operação
  if (atual && atual.status === 'FAILED' && atual.lastErrorClass === 'VALIDATION') throw retryNotAllowed();
  return transitionDispatch(ctx, id, 'RETRY_WAIT', { nextAttemptAt: new Date() }, { humanRetry: true, motivo: 'Retry humano autorizado.' }, transaction);
}

module.exports = { retryDispatchManually };
