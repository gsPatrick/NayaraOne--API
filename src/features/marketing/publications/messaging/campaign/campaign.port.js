'use strict';

const { registerCampaignSendPort, getCampaignSendPort } = require('../../../campaigns');
const { buildCampaignSendPort, audiencePurposes } = require('../../../suppression');
const { sendMarketingMessage } = require('../message/message.send');
const { resolveStepContent } = require('./campaign.content');

/**
 * `send` do step de campanha (M9-D429): depois do canSend da porta, monta a mensagem do step (conteúdo aprovado ou template), manda pelo ChannelAdapter
 * com a action_key sha256 do step como chave de idempotência e devolve { ok, externalRef, errorCode } ao disparo, que grava SENT, BLOCKED ou FAILED. A
 * finalidade gravada na mensagem é a do público (a primeira, em ordem). Erro de regra (template reprovado, preview sensível, sem descadastro) vira FAILED
 * com o código MKT_*, nunca uma exceção sem nome.
 */
async function sendStep(ctx) {
  try {
    const [purpose] = [].concat(await audiencePurposes(ctx));
    const content = await resolveStepContent(ctx);
    const out = await sendMarketingMessage(
      { tenant: ctx.tenant, transaction: ctx.transaction, now: ctx.now },
      { channel: ctx.step.channel, personId: ctx.personId, purpose, actionKey: ctx.actionKey, ...content },
    );
    if (out.status === 'SENT') return { ok: true, externalRef: out.providerRef || undefined };
    return { ok: false, errorCode: out.code || `CHANNEL_${out.status}` };
  } catch (err) {
    return { ok: false, errorCode: err && err.code ? err.code : 'SEND_EXCEPTION' };
  }
}

/** Porta da campanha: canSend (M9-D418) e envio pelo adapter real. */
const buildMessagingCampaignPort = () => buildCampaignSendPort({ send: sendStep });

/** Registra a porta no disparo dos steps (uma vez; porta já registrada por outro dono não é trocada). Chamado na subida do job de ciclo de vida das campanhas. */
function installCampaignSendPort() {
  if (!getCampaignSendPort()) registerCampaignSendPort(buildMessagingCampaignPort());
}

module.exports = { sendStep, buildMessagingCampaignPort, installCampaignSendPort };
