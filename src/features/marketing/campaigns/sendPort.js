'use strict';

/**
 * Porta de envio dos steps de campanha (M9-D412). Quem decide se pode enviar (`canSend`, M9-D418: supressão, opt-in, frequency cap,
 * quiet hours) e quem entrega pelo adapter do canal (`send`, M9-D429) são demandas próprias; o disparo da campanha só conhece este
 * contrato e nunca reimplementa a precedência. Enquanto nenhuma porta estiver registrada o job NÃO dispara nada: os steps vencidos
 * continuam SCHEDULED (nunca se marca enviado sem ter enviado).
 *
 *   canSend(ctx) -> { allowed: boolean, reason?: string }
 *   send(ctx)    -> { ok: boolean, externalRef?: string, errorCode?: string }   (idempotente por ctx.actionKey)
 * ctx = { tenant, campaign: { id, code, channels }, step: { id, stepNo, channel, templateId, contentItemId }, personId, actionKey, now }
 */
let port = null;

function registerCampaignSendPort(next) {
  if (!next || typeof next.canSend !== 'function' || typeof next.send !== 'function') {
    throw new TypeError('A porta de envio da campanha precisa implementar canSend e send.');
  }
  port = next;
}
const clearCampaignSendPort = () => { port = null; };
const getCampaignSendPort = () => port;

module.exports = { registerCampaignSendPort, clearCampaignSendPort, getCampaignSendPort };
