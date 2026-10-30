'use strict';

const { Op } = require('sequelize');
const { IntegrationConnection, IntegrationDispatch } = require('../../../models');
const { registerDispatchCycleStep } = require('../dispatch/worker/worker.hooks');

/**
 * Drenagem da connection antiga numa troca de fornecedor (M9-D221 3.1 item 4): os envios que já estavam na fila quando a troca aconteceu TERMINAM na connection antiga;
 * os novos resolvem a connection nova (só uma ACTIVE por vez). Enquanto houver envio a enviar, a connection pausada pela troca carrega `policy_json.swap.draining = true` e o
 * worker a trata como enviável. Quando a fila dela esvazia, a marca sai sozinha na rodada seguinte, e a connection antiga fica PAUSED de verdade.
 */
const isDraining = (connection) => Boolean(connection && connection.status === 'PAUSED' && connection.policyJson && connection.policyJson.swap && connection.policyJson.swap.draining === true);

/** Ainda há envio por fazer nesta connection (a enviar, em nova tentativa ou incerto)? Envio já aceito e esperando o webhook não segura a drenagem. */
async function hasOpenDispatches(connectionId, companyId, transaction) {
  return (await IntegrationDispatch.count({ where: { connectionId, companyId, status: { [Op.in]: ['PENDING', 'SENDING', 'RETRY_WAIT', 'UNKNOWN'] } }, transaction })) > 0;
}

/** Passo da rodada do worker: encerra a drenagem das connections da empresa cuja fila esvaziou. */
async function finishDrains(ctx, _opts, transaction) {
  const pausadas = await IntegrationConnection.findAll({ where: { companyId: ctx.companyId, status: 'PAUSED' }, transaction });
  for (const c of pausadas.filter(isDraining)) {
    if (await hasOpenDispatches(c.id, ctx.companyId, transaction)) continue;
    const { swap, ...resto } = c.policyJson;
    await c.update({ policyJson: { ...resto, swap: { ...swap, draining: false, drainedAt: new Date().toISOString() } } }, { transaction });
  }
}

let installed = false;
function installSwapDrain() {
  if (installed) return;
  installed = true;
  registerDispatchCycleStep(finishDrains);
}

module.exports = { isDraining, hasOpenDispatches, finishDrains, installSwapDrain };
