'use strict';

const { Op } = require('sequelize');
const { sequelize, IntegrationDispatch } = require('../../../models');
const { applyTransition } = require('./dispatch.transition');

/**
 * claimDue — o worker pega até `limit` envios PENDING ou RETRY_WAIT vencidos com FOR UPDATE SKIP LOCKED e os leva a
 * SENDING (attempts+1). A linha é relida já travada: dois workers nunca executam o mesmo envio.
 * Roda numa transação no contexto da empresa.
 */
async function claimDue(ctx, limit, transaction) {
  const rows = await IntegrationDispatch.findAll({
    where: {
      companyId: ctx.companyId, status: { [Op.in]: ['PENDING', 'RETRY_WAIT'] },
      [Op.or]: [{ nextAttemptAt: null }, { nextAttemptAt: { [Op.lte]: sequelize.literal('now()') } }],
    },
    order: [['next_attempt_at', 'ASC'], ['id', 'ASC']],
    limit: Math.max(1, Math.min(Number(limit) || 10, 500)),
    transaction, lock: transaction.LOCK.UPDATE, skipLocked: true,
  });
  const pegos = [];
  for (const row of rows) pegos.push(await applyTransition(ctx, row, 'SENDING', {}, { motivo: 'Envio pego pelo worker.' }, transaction));
  return pegos;
}

module.exports = { claimDue };
