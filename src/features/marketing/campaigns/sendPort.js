'use strict';

/**
 * Porta de envio dos steps de campanha (M9-D412). Quem decide se pode enviar (`canSend`, M9-D418: supressão, opt-in, frequency cap,
 * quiet hours) e quem entrega pelo adapter do canal (`send`, M9-D429) são demandas próprias; o disparo da campanha só conhece este
 * contrato e nunca reimplementa a precedência. Enquanto nenhuma porta estiver registrada o job NÃO dispara nada: os steps vencidos
 * continuam SCHEDULED (nunca se marca enviado sem ter enviado).
 *
 *   canSend(ctx) -> { allowed: boolean, reason?: string }
 *   send(ctx)    -> { ok: boolean, externalRef?: string, errorCode?: string, transient?, unknown?, deferred?, rateLimited?, retryAfterMs? }   (idempotente por ctx.actionKey)
 *                   sem transient/unknown/deferred, ok:false é falha DEFINITIVA (FAILED); transient vira RETRY com backoff; unknown vira UNKNOWN (reconciliar antes).
 * Opcionais (a porta de mensagens da M9-D429 implementa; porta sem eles nunca reenvia às cegas):
 *   reconcile(ctx) -> { found: true, externalRef } | { notFound: true } | { error }   (consulta o provedor pela chave, sem enviar)
 *   settle(ctx, { status: 'FAILED'|'CANCELLED', code })                             (fecha a mensagem do CRM que ficou na fila)
 *   reopen(ctx)                                                                      (reprocessamento: a mensagem fechada volta à fila)
 * ctx = { tenant, campaign: { id, code, channels }, step: { id, stepNo, channel, templateId, contentItemId }, personId, actionKey, now, transaction, attempt }
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
