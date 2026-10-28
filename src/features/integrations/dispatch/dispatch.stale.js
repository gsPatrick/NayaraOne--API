'use strict';

const { Op } = require('sequelize');
const { sequelize, IntegrationDispatch } = require('../../../models');
const { applyTransition } = require('./dispatch.transition');
const { readDispatchParams } = require('./dispatch.params');

/**
 * recoverStaleSending — o processo morreu no meio: envio em SENDING há mais de `integration.dispatch.sending_stale_s`
 * (padrão 120 s) vai a UNKNOWN (a reconciliação da M9-D215 decide). Devolve os envios recuperados.
 */
async function recoverStaleSending(ctx, transaction) {
  const params = await readDispatchParams(ctx, transaction);
  const velhos = await IntegrationDispatch.findAll({
    where: { companyId: ctx.companyId, status: 'SENDING', updated_at: { [Op.lt]: sequelize.literal(`now() - make_interval(secs => ${Number(params.sendingStaleS)})`) } },
    transaction, lock: transaction.LOCK.UPDATE, skipLocked: true,
  });
  const out = [];
  for (const row of velhos) out.push(await applyTransition(ctx, row, 'UNKNOWN', { lastErrorClass: 'UNKNOWN', lastErrorCode: 'SENDING_STALE' }, { motivo: 'Envio em SENDING sem resposta: estado desconhecido até a reconciliação.' }, transaction));
  return out;
}

module.exports = { recoverStaleSending };
