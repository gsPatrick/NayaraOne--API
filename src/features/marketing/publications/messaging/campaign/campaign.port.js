'use strict';

const { sequelize } = require('../../../../../models');
const { registerCampaignSendPort, getCampaignSendPort } = require('../../../campaigns');
const { buildCampaignSendPort, audiencePurposes } = require('../../../suppression');
const { sendMarketingMessage } = require('../message/message.send');
const { resolveStepContent } = require('./campaign.content');
const { classifyMessageOutcome, classifySendException } = require('./campaign.outcome');
const { reconcileStep, settleStep, reopenStep } = require('./campaign.followup');

/**
 * `send` do step de campanha (M9-D429): depois do canSend da porta, monta a mensagem do step (conteúdo aprovado ou template), manda pelo ChannelAdapter
 * com a action_key sha256 do step como chave de idempotência e devolve ao disparo { ok, externalRef, errorCode, transient, unknown, deferred, ... }
 * (campaign.outcome.js): o disparo grava SENT, RETRY (transitória), UNKNOWN (incerta) ou FAILED (definitiva). A finalidade gravada na mensagem é a do
 * público (a primeira, em ordem). O envio roda em savepoint: um erro no meio (banco, cofre) não aborta o lote; a idempotência do provedor pela mesma
 * chave garante que a nova tentativa nunca duplica. Reenvio (attempt > 1): a mensagem já gravada com a chave é retomada (resumeExisting, M9-D415).
 */
async function sendStep(ctx) {
  try {
    const out = await sequelize.transaction({ transaction: ctx.transaction }, async (inner) => {
      const scoped = { ...ctx, transaction: inner };
      const [purpose] = [].concat(await audiencePurposes(scoped));
      const content = await resolveStepContent(scoped);
      return sendMarketingMessage(
        { tenant: ctx.tenant, transaction: inner, now: ctx.now, campaignId: ctx.campaign.id },
        { channel: ctx.step.channel, personId: ctx.personId, purpose, actionKey: ctx.actionKey, ...content },
      );
    });
    return classifyMessageOutcome(out);
  } catch (err) {
    return classifySendException(err);
  }
}

/** Porta da campanha: canSend (M9-D418), envio pelo adapter real e o acompanhamento da mensagem do CRM (reconciliar, fechar, reabrir). */
const buildMessagingCampaignPort = () => ({ ...buildCampaignSendPort({ send: sendStep }), reconcile: reconcileStep, settle: settleStep, reopen: reopenStep });

/** Registra a porta no disparo dos steps (uma vez; porta já registrada por outro dono não é trocada). Chamado na subida do job de ciclo de vida das campanhas. */
function installCampaignSendPort() {
  if (!getCampaignSendPort()) registerCampaignSendPort(buildMessagingCampaignPort());
}

module.exports = { sendStep, buildMessagingCampaignPort, installCampaignSendPort };
