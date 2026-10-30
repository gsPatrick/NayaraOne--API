'use strict';

const { MODES, FAMILY_DEFAULT_MODE, MODES_WITH_ALTERNATE } = require('../../../../integrations/contingency/contingency.constants');
const { modeQueueMaxAgeH } = require('../../../../integrations/contingency/contingency.params');
const { CHANNEL_META } = require('../channels');
const { normalizeChannel } = require('../channel.errors');

/**
 * M9-D430 3.8 — contingência de canal. Esta demanda é a ÚNICA dona: o Marketing não cria modo de contingência próprio e aponta, canal por canal, para o
 * que o bloco B entrega. O modo vem das constantes do framework (M9-D226), nunca escrito aqui:
 *  - WHATSAPP = QUEUE_AND_ALTERNATE (família MESSAGING; política de M9-D227): mensagem na fila, nunca entregue; alternativo só com consentimento;
 *  - EMAIL = nova tentativa por classe de erro (M9-D216), sem modo;
 *  - SITE e PORTAL = KEEP_INTERNAL_AND_REPROCESS: publicação interna mantida e reprocessada (PENDING_SYNC; SiteAdapter de M9-D259, portal em M9-D227);
 *  - INSTAGRAM, FACEBOOK, LINKEDIN, YOUTUBE, TIKTOK = falha isolada por rede (M9-D410) e nova tentativa por classe (M9-D216), sem fila alternativa.
 */
const KEEP_INTERNAL = MODES.find((m) => m === 'KEEP_INTERNAL_AND_REPROCESS');
const PLANS = {
  WHATSAPP: { mode: FAMILY_DEFAULT_MODE.MESSAGING, queue: true, alternate: { allowed: MODES_WITH_ALTERNATE.includes(FAMILY_DEFAULT_MODE.MESSAGING), requiresConsent: true }, retry: 'BY_ERROR_CLASS', isolated: false, refs: ['M9-D226', 'M9-D227'] },
  EMAIL: { mode: null, queue: false, alternate: false, retry: 'BY_ERROR_CLASS', isolated: false, refs: ['M9-D216'] },
  SITE: { mode: KEEP_INTERNAL, queue: false, alternate: false, retry: 'BY_ERROR_CLASS', isolated: false, keepInternal: true, refs: ['M9-D259'] },
  PORTAL: { mode: FAMILY_DEFAULT_MODE.PORTAL, queue: false, alternate: false, retry: 'BY_ERROR_CLASS', isolated: false, keepInternal: true, refs: ['M9-D227'] },
};
for (const social of ['INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'TIKTOK']) {
  PLANS[social] = { mode: null, queue: false, alternate: false, retry: 'BY_ERROR_CLASS', isolated: true, refs: ['M9-D410', 'M9-D216'] };
}

/** O plano de contingência do canal (somente leitura). */
function planFor(channelName) {
  const channel = normalizeChannel(channelName);
  return Object.freeze({ channel, owner: 'M9-D430', family: CHANNEL_META[channel].family, ...PLANS[channel] });
}

/** Classes de erro em que repetir não adianta (credencial e validação): a nova tentativa por classe do bloco B não entra em laço. */
const NEVER_RETRY = Object.freeze(['AUTH', 'VALIDATION']);

/**
 * Prazo da fila vencido? O prazo é o parâmetro do modo do bloco B (`integration.contingency.queue_max_age_h.<modo>`, M9-D226): a mensagem de marketing
 * que vence é cancelada.
 */
async function isQueueExpired({ queuedAt, now = new Date() }, tenant, transaction) {
  const hours = await modeQueueMaxAgeH(PLANS.WHATSAPP.mode, tenant, transaction);
  if (hours === null) return false;
  return now.getTime() - new Date(queuedAt).getTime() > hours * 3600 * 1000;
}

/**
 * O que o Marketing faz com o resultado de um envio/publicação, segundo o plano do canal. `options.queueExpired` (de isQueueExpired) cancela a mensagem
 * de WhatsApp que venceu a fila. Nunca marca entregue o que não foi confirmado.
 */
function decideOnResult(channelName, result, options = {}) {
  const plan = planFor(channelName);
  const base = { channel: plan.channel, mode: plan.mode, alternate: plan.alternate, delivered: false, blocksOthers: false, retry: 'NONE' };
  // SENT/PUBLISHED é o que o canal aceitou; "entregue" só vem do status/webhook do canal, nunca daqui.
  if (['SENT', 'PUBLISHED'].includes(result.status)) return { ...base, action: 'NONE', state: result.status };
  if (result.status === 'REJECTED') return { ...base, action: 'REJECT', state: 'REJECTED' };
  const klass = result.error && result.error.class;
  const retry = NEVER_RETRY.includes(klass) ? 'NONE' : plan.retry;
  if (result.unknown) return unknownDecision(plan, base);
  if (plan.queue) return options.queueExpired ? { ...base, action: 'CANCEL_QUEUED', state: 'CANCELLED' } : { ...base, action: 'QUEUE', state: 'QUEUED', retry };
  if (plan.keepInternal) return { ...base, action: 'KEEP_INTERNAL', state: 'PENDING_SYNC', keepInternal: true, reprocess: true, retry };
  if (plan.isolated) return { ...base, action: 'ISOLATE_AND_RETRY', state: 'FAILED', retry };
  return { ...base, action: 'RETRY_BY_CLASS', state: 'FAILED', retry };
}

/** Resposta incerta: consulta antes de repetir (INT-005). O estado interno não vira definitivo para nenhum lado. */
function unknownDecision(plan, base) {
  if (plan.queue) return { ...base, action: 'RECONCILE_FIRST', state: 'QUEUED' };
  if (plan.keepInternal) return { ...base, action: 'KEEP_INTERNAL', state: 'PENDING_SYNC', keepInternal: true, reprocess: true, reconcile: true };
  if (plan.isolated) return { ...base, action: 'ISOLATE_AND_RETRY', state: 'UNKNOWN', retry: 'AFTER_RECONCILE' };
  return { ...base, action: 'RECONCILE_FIRST', state: 'UNKNOWN' };
}

module.exports = { planFor, decideOnResult, isQueueExpired };
