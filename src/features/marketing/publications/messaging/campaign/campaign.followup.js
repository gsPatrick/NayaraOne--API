'use strict';

const { Message } = require('../../../../../models');
const { resolveChannelAdapter } = require('../../adapters');
const { withTimeout } = require('../../worker/worker.call');
const { KEYS, WORKER_SETTING_DEFAULTS } = require('../../worker/worker.settings');
const { moveOutbound, STATUS_TEXT } = require('../message/message.persist');

/**
 * O que a porta da campanha faz DEPOIS do primeiro envio, sobre a mensagem do CRM gravada com a action_key do step (verificação K=7, item 5):
 *  - reconcile: o resultado ficou incerto (UNKNOWN). Pergunta ao provedor pela chave de idempotência (findByIdempotencyKey, o mesmo mecanismo do
 *    reenvio da M9-D415 e do worker de publicação), sem enviar nada. Achou -> a mensagem vira SENT. Confirmou que não recebeu -> a mensagem vira QUEUED
 *    (aguarda a nova tentativa, que reusa a mesma chave). Sem resposta conclusiva -> { error } e nada muda.
 *  - settle: a entrega fechou sem sair (tentativas esgotadas, opt-out entre tentativas, campanha encerrada): a mensagem QUEUED vira FAILED ou CANCELLED.
 *    Mensagem UNKNOWN não é tocada (não se finge falha do que pode ter saído).
 *  - reopen: reprocessamento do administrador: a mensagem que fechou FAILED por tentativas esgotadas volta a QUEUED para o reenvio com a mesma chave.
 */

const lockByKey = (ctx) => Message.findOne({ where: { companyId: ctx.tenant.companyId, actionKey: ctx.actionKey }, transaction: ctx.transaction, lock: ctx.transaction.LOCK.UPDATE });
const stateOf = (row) => row.deliveryStatus || row.status;

async function timeoutMs(ctx) {
  const { getSetting } = require('../../../../settings/settings.service'); // leitura tardia (o dicionário de parâmetros carrega o worker)
  const seconds = Number(await getSetting(KEYS.timeout, ctx.tenant, ctx.transaction, WORKER_SETTING_DEFAULTS[KEYS.timeout]));
  return (Number.isInteger(seconds) && seconds >= 1 ? seconds : WORKER_SETTING_DEFAULTS[KEYS.timeout]) * 1000;
}

async function reconcileStep(ctx) {
  const adapter = await resolveChannelAdapter(ctx.step.channel, { tenant: ctx.tenant, transaction: ctx.transaction });
  const outcome = await withTimeout(adapter.findByIdempotencyKey(ctx.actionKey), await timeoutMs(ctx));
  if (outcome.timedOut) return { error: 'RECONCILE_TIMEOUT' };
  if (outcome.error) return { error: (outcome.error && outcome.error.code) || 'RECONCILE_EXCEPTION' };
  const answer = outcome.value;
  if (!answer || answer.error) return { error: (answer && answer.error && answer.error.code) || 'RECONCILE_EMPTY' };
  const row = await lockByKey(ctx);
  if (answer.found === true) {
    if (row && stateOf(row) !== 'SENT') await moveOutbound(row, { status: 'SENT', providerRef: answer.providerRef }, ctx.transaction);
    return { found: true, externalRef: answer.providerRef || undefined };
  }
  if (answer.found !== false) return { error: 'RECONCILE_INCONCLUSIVE' };
  if (row && stateOf(row) === 'UNKNOWN') await moveOutbound(row, { status: 'QUEUED', reason: STATUS_TEXT.QUEUED }, ctx.transaction);
  return { notFound: true };
}

const SETTLE_TEXT = {
  FAILED: (code) => `As tentativas de envio acabaram sem o canal aceitar a mensagem (${code}).`,
  CANCELLED: (code) => `Envio cancelado sem sair: ${code}.`,
};

async function settleStep(ctx, { status, code }) {
  const row = await lockByKey(ctx);
  if (!row || stateOf(row) !== 'QUEUED' || !SETTLE_TEXT[status]) return { changed: false };
  await moveOutbound(row, { status, reason: SETTLE_TEXT[status](code) }, ctx.transaction);
  return { changed: true };
}

async function reopenStep(ctx) {
  const row = await lockByKey(ctx);
  if (!row || stateOf(row) !== 'FAILED') return { changed: false };
  await moveOutbound(row, { status: 'QUEUED', reason: STATUS_TEXT.QUEUED }, ctx.transaction);
  return { changed: true };
}

module.exports = { reconcileStep, settleStep, reopenStep };
