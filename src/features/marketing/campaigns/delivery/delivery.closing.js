'use strict';

const logger = require('../../../../utils/logger');
const repo = require('./delivery.repository');
const { planReconcile, readDeliveryPolicy } = require('./delivery.policy');
const { STATUS, CODES } = require('./delivery.constants');
const { auditDelivery } = require('./delivery.audit');

/** Contexto da porta para uma linha lida por openOfClosedSteps. */
const portCtxOf = (row, tenant, now, transaction) => ({
  tenant, campaign: { id: row.campaign_id, code: row.campaign_code, channels: row.channels },
  step: { id: row.step_id, stepNo: row.step_no, channel: row.channel, templateId: row.template_id, contentItemId: row.content_item_id },
  personId: row.person_id, actionKey: row.action_key, now, transaction, attempt: Number(row.attempts),
});

const closeReason = (row) => (row.step_status === 'SCHEDULED' ? CODES.CAMPAIGN_ENDED : (row.step_reason || CODES.CAMPAIGN_ENDED));

/** RETRY de step fechado: nada saiu e nada mais sai. CANCELLED, e a mensagem do CRM que ficou QUEUED também (nunca fica na fila para sempre). */
async function cancelRetry(row, port, tenant, now, transaction) {
  const reason = closeReason(row);
  await repo.updateDelivery(row.id, tenant, { status: STATUS.CANCELLED, reason }, transaction);
  if (port && typeof port.settle === 'function') await port.settle(portCtxOf(row, tenant, now, transaction), { status: STATUS.CANCELLED, code: reason });
  await auditDelivery(tenant, 'cancelled', row.id, { before: { status: row.status, reason: row.reason, attempts: row.attempts }, after: { status: STATUS.CANCELLED, reason },
    reason: `Entrega aberta da campanha ${row.campaign_code} cancelada sem envio: ${reason}.` }, transaction);
  return 'CANCELLED';
}

/**
 * UNKNOWN de step fechado: só reconcilia, nunca envia (campanha encerrada não continua). Achou -> SENT (o e-mail saiu de fato); o provedor confirmou que não
 * recebeu -> CANCELLED; consulta sem resposta -> espera e tenta de novo até o limite, depois FAILED (fila morta).
 */
async function reconcileOnly(row, port, policy, tenant, now, transaction) {
  let answer = { error: 'RECONCILE_UNSUPPORTED' };
  if (port && typeof port.reconcile === 'function') {
    try { answer = await port.reconcile(portCtxOf(row, tenant, now, transaction)); } catch (err) { answer = { error: (err && err.code) || 'RECONCILE_EXCEPTION' }; }
  }
  const before = { status: STATUS.UNKNOWN, reconcileAttempts: row.reconcile_attempts };
  if (answer && answer.found) {
    await repo.updateDelivery(row.id, tenant, { status: STATUS.SENT, reason: null, externalRef: answer.externalRef, reconcileAttempts: row.reconcile_attempts + 1 }, transaction);
    await auditDelivery(tenant, 'reconciled', row.id, { before, after: { status: STATUS.SENT, found: true }, reason: `O provedor confirmou o e-mail da campanha ${row.campaign_code} já encerrada: entrega SENT.` }, transaction);
    return 'SENT';
  }
  if (answer && answer.notFound) return cancelRetry({ ...row, status: STATUS.UNKNOWN }, port, tenant, now, transaction);
  const plan = planReconcile(row.reconcile_attempts + 1, policy, now);
  if (plan.exhausted) {
    await repo.updateDelivery(row.id, tenant, { status: STATUS.FAILED, reason: CODES.UNKNOWN_EXHAUSTED, reconcileAttempts: plan.reconcileAttempts }, transaction);
    await auditDelivery(tenant, 'failed', row.id, { before, after: { status: STATUS.FAILED, reason: CODES.UNKNOWN_EXHAUSTED }, reason: `Resultado do e-mail da campanha ${row.campaign_code} continua incerto; vai para reprocessamento.` }, transaction);
    return 'FAILED';
  }
  await repo.updateDelivery(row.id, tenant, { status: STATUS.UNKNOWN, reason: row.reason, reconcileAttempts: plan.reconcileAttempts, nextAttemptAt: plan.nextAttemptAt }, transaction);
  return 'UNKNOWN';
}

/**
 * Entregas abertas de steps que não estão mais SCHEDULED (campanha encerrada, step pulado): RETRY é cancelada na hora; UNKNOWN vencido é só reconciliado.
 * Chamado no encerramento da campanha (`campaignId`) e a cada rodada do ciclo de vida (todas as campanhas da empresa). Cada linha em savepoint próprio.
 */
async function closeOpenOfClosedSteps(tenant, { port, now = new Date(), campaignId = null, sequelize }, transaction) {
  const totals = { cancelled: 0, reconciled: 0, failed: 0, unknown: 0 };
  const retries = await repo.openOfClosedSteps(tenant, { campaignId, status: STATUS.RETRY }, transaction);
  const unknowns = await repo.openOfClosedSteps(tenant, { campaignId, status: STATUS.UNKNOWN, dueBy: now }, transaction);
  const policy = unknowns.length ? await readDeliveryPolicy(tenant, transaction) : null;
  const work = [...retries.map((row) => (tx) => cancelRetry(row, port, tenant, now, tx)), ...unknowns.map((row) => (tx) => reconcileOnly(row, port, policy, tenant, now, tx))];
  for (const step of work) {
    try {
      const out = await sequelize.transaction({ transaction }, (inner) => step(inner));
      if (out === 'CANCELLED') totals.cancelled += 1; else if (out === 'SENT') totals.reconciled += 1; else if (out === 'FAILED') totals.failed += 1; else totals.unknown += 1;
    } catch (err) {
      logger.error({ err: err.message }, 'marketing.campaign.delivery.close.failed');
    }
  }
  return totals;
}

module.exports = { closeOpenOfClosedSteps, portCtxOf };
