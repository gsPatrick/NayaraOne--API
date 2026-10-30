'use strict';

const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const { recordAiCall } = require('./collectors/ai');
const { recordMessages, CHANNEL_BY_OPERATION } = require('./collectors/messaging');

/**
 * Ganchos dos coletores (M9-D860): os pontos do sistema que gastam dinheiro avisam o ledger. Rodam numa subtransação e NUNCA derrubam quem os chamou:
 * se o registro do custo falhar, a chamada de IA ou o envio segue e a falha vai ao log (o custo daquela unidade fica sem registro, nunca inventado).
 */
async function safely(label, transaction, work) {
  try {
    await sequelize.transaction({ transaction }, () => work());
  } catch (err) {
    logger.warn({ label, err: err.message }, 'finops.hook.failed');
  }
}

/** Fim de uma execução da NAY (estado final): tokens e modelo viram custo ESTIMATED da hora. Resposta de cache não gasta nada. */
function onAiRunFinished(ctx, run, finalStatuses, transaction) {
  const tokens = (run.tokensIn || 0) + (run.tokensOut || 0);
  if (!finalStatuses.includes(run.status) || run.cached || !tokens || !run.providerCode || !run.modelCode) return Promise.resolve();
  return safely('ai.run', transaction, () => recordAiCall({ groupId: ctx.groupId, companyId: ctx.companyId }, {
    providerCode: run.providerCode, modelCode: run.modelCode, tokensIn: run.tokensIn || 0, tokensOut: run.tokensOut || 0,
  }, transaction));
}

/** Envio de mensageria ou e-mail confirmado pelo fornecedor: uma unidade no canal correspondente. */
function onDispatchConfirmed(ctx, dispatch, transaction) {
  const channel = CHANNEL_BY_OPERATION[dispatch.operation];
  if (!channel) return Promise.resolve();
  return safely('dispatch.confirmed', transaction, () => recordMessages({ groupId: ctx.groupId, companyId: ctx.companyId }, { channel, quantity: 1 }, transaction));
}

module.exports = { onAiRunFinished, onDispatchConfirmed };
