'use strict';

const logger = require('../../../../utils/logger');
const repo = require('./delivery.repository');
const { planRetry, planReconcile } = require('./delivery.policy');
const { STATUS, CODES } = require('./delivery.constants');
const { auditDelivery } = require('./delivery.audit');

/** Resultado do envio que não é falha: o destinatário continua pendente, sem gravar nada (kill switch ligado no meio do lote, circuito aberto). */
const isHold = (sent) => Boolean(sent && (sent.deferred || sent.errorCode === 'MKT_KILL_SWITCH_ACTIVE'));

/** A porta pode não reconciliar (porta de teste): sem resposta conclusiva, o UNKNOWN espera e esgota (fila morta), nunca reenvia às cegas. */
async function askProvider(port, portCtx) {
  if (typeof port.reconcile !== 'function') return { error: 'RECONCILE_UNSUPPORTED' };
  try {
    return (await port.reconcile(portCtx)) || { error: 'RECONCILE_EMPTY' };
  } catch (err) {
    logger.warn({ stepId: portCtx.step.id, code: err && err.code }, 'marketing.campaign.reconcile.failed');
    return { error: (err && err.code) || 'RECONCILE_EXCEPTION' };
  }
}

/** Fecha a mensagem do CRM ainda aberta (QUEUED) quando a entrega fecha sem sair: nada fica QUEUED para sempre. */
async function settleMessage(port, portCtx, status, code) {
  if (typeof port.settle !== 'function') return;
  await port.settle(portCtx, { status, code });
}

/** Falha transitória: RETRY com backoff, ou FAILED quando as tentativas acabaram (a mensagem do CRM, se ficou QUEUED, fecha como FAILED). */
async function transientFailure(state, sent) {
  const { tenant, delivery, base, now, policy, port, portCtx, transaction } = state;
  const plan = planRetry(delivery, { rateLimited: sent.rateLimited, retryAfterMs: sent.retryAfterMs }, policy, now);
  if (!plan.exhausted) {
    await repo.saveDelivery(tenant, base, delivery, { status: STATUS.RETRY, reason: sent.errorCode, attempts: plan.attempts, rateDeferrals: plan.rateDeferrals, reconcileAttempts: 0, nextAttemptAt: plan.nextAttemptAt }, transaction);
    return 'RETRY';
  }
  const [row] = await repo.saveDelivery(tenant, base, delivery, { status: STATUS.FAILED, reason: CODES.RETRIES_EXHAUSTED, attempts: plan.attempts, rateDeferrals: plan.rateDeferrals }, transaction);
  await settleMessage(port, portCtx, STATUS.FAILED, CODES.RETRIES_EXHAUSTED);
  await auditDelivery(tenant, 'failed', (row && row.id) || (delivery && delivery.id), {
    before: delivery ? { status: delivery.status, attempts: delivery.attempts, reason: delivery.reason } : null, after: { status: STATUS.FAILED, reason: CODES.RETRIES_EXHAUSTED, lastCode: sent.errorCode, attempts: plan.attempts },
    reason: `Entrega da campanha ${state.campaign.code} sem sucesso depois de ${plan.attempts} tentativa(s) por falha transitória (${sent.errorCode}); fica para reprocessamento.`,
  }, transaction);
  return 'FAILED';
}

/** UNKNOWN: consulta o provedor pela chave ANTES de qualquer reenvio. Devolve o desfecho, ou null quando o provedor confirmou que não recebeu (pode enviar). */
async function reconcileFirst(state) {
  const { tenant, delivery, base, now, policy, port, portCtx, transaction, campaign } = state;
  const answer = await askProvider(port, portCtx);
  if (answer.found) {
    await repo.saveDelivery(tenant, base, delivery, { status: STATUS.SENT, reason: null, externalRef: answer.externalRef, reconcileAttempts: delivery.reconcile_attempts + 1 }, transaction);
    await auditDelivery(tenant, 'reconciled', delivery.id, { before: { status: STATUS.UNKNOWN }, after: { status: STATUS.SENT, found: true }, reason: `O provedor confirmou o e-mail da campanha ${campaign.code}: entrega SENT, sem reenvio.` }, transaction);
    return 'SENT';
  }
  if (answer.notFound) {
    await auditDelivery(tenant, 'reconciled', delivery.id, { before: { status: STATUS.UNKNOWN }, after: { found: false }, reason: `O provedor confirmou que não recebeu o e-mail da campanha ${campaign.code}: segue para nova tentativa com a mesma chave.` }, transaction);
    if (Number(delivery.attempts) < policy.retry.max_attempts) return null;
    return transientFailure({ ...state, delivery: { ...delivery, rate_deferrals: 0 } }, { errorCode: CODES.RECONCILED_NOT_FOUND }); // tentativas já esgotadas: fecha FAILED, sem reenvio
  }
  const plan = planReconcile(delivery.reconcile_attempts + 1, policy, now);
  if (plan.exhausted) {
    await repo.saveDelivery(tenant, base, delivery, { status: STATUS.FAILED, reason: CODES.UNKNOWN_EXHAUSTED, reconcileAttempts: plan.reconcileAttempts }, transaction);
    await auditDelivery(tenant, 'failed', delivery.id, { before: { status: STATUS.UNKNOWN, reconcileAttempts: delivery.reconcile_attempts }, after: { status: STATUS.FAILED, reason: CODES.UNKNOWN_EXHAUSTED, lastCode: answer.error },
      reason: `Resultado do e-mail da campanha ${campaign.code} continua incerto depois de ${plan.reconcileAttempts} consulta(s); a mensagem do CRM fica UNKNOWN e a entrega vai para reprocessamento.` }, transaction);
    return 'FAILED';
  }
  await repo.saveDelivery(tenant, base, delivery, { status: STATUS.UNKNOWN, reason: delivery.reason, reconcileAttempts: plan.reconcileAttempts, nextAttemptAt: plan.nextAttemptAt }, transaction);
  return 'UNKNOWN';
}

/**
 * Um destinatário do step (M9-D418 + M9-D429 + verificação K=7 item 5). Ordem: UNKNOWN reconcilia antes de tudo; canSend NA HORA (opt-out entre tentativas
 * bloqueia e fecha a mensagem aberta); envio pelo adapter com a mesma action_key (idempotência do provedor). Desfechos: SENT; BLOCKED; RETRY (transitória, com
 * backoff e limite); UNKNOWN (incerto, reconciliar); FAILED (definitiva, ou limite esgotado); DEFERRED (silêncio, kill switch: nada é gravado).
 */
async function processRecipient(port, ctx, policy, transaction) {
  const { tenant, campaign, step, personId, now, delivery, actionKey } = ctx;
  const portCtx = {
    tenant, campaign: { id: campaign.id, code: campaign.code, channels: campaign.channels }, step: { id: step.id, stepNo: step.step_no, channel: step.channel, templateId: step.template_id, contentItemId: step.content_item_id },
    personId, actionKey, now, transaction, attempt: (delivery ? Number(delivery.attempts) : 0) + 1,
  };
  const base = { campaignId: campaign.id, stepId: step.id, personId, actionKey };
  const state = { tenant, campaign, delivery, base, now, policy, port, portCtx, transaction };

  if (delivery && delivery.status === STATUS.UNKNOWN) {
    const settled = await reconcileFirst(state);
    if (settled) return settled;
  }
  let decision;
  try { decision = await port.canSend(portCtx); } catch (err) {
    logger.error({ err: err.message, stepId: step.id }, 'marketing.campaign.cansend.failed');
    return transientFailure(state, { errorCode: CODES.CANSEND_ERROR }); // falha passageira de leitura: nova tentativa, nunca bloqueio definitivo
  }
  if (decision && decision.allowed !== true && decision.reason === 'QUIET_HOURS') return 'DEFERRED'; // reagendada para fora do silêncio, não perdida
  if (!decision || decision.allowed !== true) {
    const reason = (decision && decision.reason) || 'NOT_ALLOWED';
    await repo.saveDelivery(tenant, base, delivery, { status: STATUS.BLOCKED, reason }, transaction);
    if (delivery) await settleMessage(port, portCtx, STATUS.CANCELLED, reason);
    return 'BLOCKED';
  }
  let sent;
  try { sent = await port.send(portCtx); } catch (err) {
    logger.error({ err: err.message, stepId: step.id }, 'marketing.campaign.send.failed');
    sent = { ok: false, errorCode: (err && err.code) || 'SEND_EXCEPTION', transient: true };
  }
  if (isHold(sent)) return 'DEFERRED'; // continua pendente e sai depois (kill switch, circuito aberto)
  if (sent && sent.ok) {
    await repo.saveDelivery(tenant, base, delivery, { status: STATUS.SENT, reason: null, externalRef: sent.externalRef, attempts: portCtx.attempt }, transaction);
    return 'SENT';
  }
  if (sent && sent.unknown) {
    const plan = planReconcile(0, policy, now);
    await repo.saveDelivery(tenant, base, delivery, { status: STATUS.UNKNOWN, reason: sent.errorCode || 'CHANNEL_UNKNOWN', attempts: portCtx.attempt, reconcileAttempts: 0, nextAttemptAt: plan.nextAttemptAt }, transaction);
    return 'UNKNOWN';
  }
  if (sent && sent.transient) return transientFailure(state, sent);
  await repo.saveDelivery(tenant, base, delivery, { status: STATUS.FAILED, reason: (sent && sent.errorCode) || 'SEND_FAILED', externalRef: sent && sent.externalRef, attempts: portCtx.attempt }, transaction);
  return 'FAILED';
}

module.exports = { processRecipient };
