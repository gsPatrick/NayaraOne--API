'use strict';

const { sequelize } = require('../../../../models');
const logger = require('../../../../utils/logger');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const ports = require('./runner.ports');
const { readDeliveryPolicy, planRetry, planReconcile, RETRY_CODES } = require('../../sendRetry.policy');

/**
 * DI-M9F-1 — nova tentativa e reconciliação da ação SEND_MESSAGE (INT-005, INT-006, Integrações §7 e §8, MKT §12), com a MESMA política da entrega de
 * campanha (sendRetry.policy: `integration.retry.*` e `integration.unknown.*`, lidos na hora, por empresa) e a mesma classificação (sendRetry.outcome):
 *  - ok: a ação fica OK (só quando o canal aceitou);
 *  - transitória (429, 5xx, cofre fora, exceção passageira): RETRY com `due_at` = backoff (ou Retry-After); a run fica WAITING e o executor das ações adiadas
 *    a retoma com o kill switch e o canSend na hora (opt-out entre tentativas bloqueia). Esgotou: FAILED `MKT_DELIVERY_RETRIES_EXHAUSTED` e a mensagem do CRM
 *    que estava QUEUED fecha FAILED;
 *  - incerta (timeout): UNKNOWN com `due_at`; na hora marcada consulta o provedor pela chave ANTES de qualquer reenvio. Achou: OK, sem reenviar. Não achou:
 *    volta à nova tentativa com a mesma chave. Sem resposta até o limite: FAILED `MKT_DELIVERY_UNKNOWN_EXHAUSTED` (fila morta; a mensagem continua UNKNOWN);
 *  - definitiva (credencial, validação, conteúdo recusado): FAILED na hora, sem nova tentativa.
 * A ação que fecha sem sair (bloqueio, automação pausada, kill switch) fecha também a mensagem do CRM que estava na fila (CANCELLED): nada fica QUEUED para sempre.
 */

const iso = (date) => new Date(date).toISOString();
const msgCtx = (ctx, entry) => ({ tenant: ctx.tenant, channel: entry.channel, actionKey: entry.action_key });
const counters = (entry) => ({ attempts: Number(entry.attempts || 0), rate_deferrals: Number(entry.rate_deferrals || 0) });

/** Fecha a mensagem do CRM que ficou QUEUED (FAILED ou CANCELLED). Mensagem UNKNOWN ou inexistente não muda. */
const settle = (ctx, entry, status, code) => ports.settleMessage({ ...msgCtx(ctx, entry), transaction: ctx.transaction }, { status, code });

/** Resultado do executor para o envio classificado (`sent`: sendRetry.outcome). `entry` é a ação como estava antes desta tentativa. */
async function resultOfSend(ctx, entry, sent) {
  const attempts = counters(entry).attempts + 1;
  if (sent.ok) return { status: 'OK', providerRef: sent.externalRef || null, fields: { attempts } };
  if (!sent.unknown && !sent.transient && !sent.deferred) return { status: 'FAILED', errorCode: 'MKT_ACTION_FAILED', detail: sent.errorCode, fields: { attempts } };
  const policy = await readDeliveryPolicy(ctx.tenant, ctx.transaction);
  if (sent.unknown) {
    const plan = planReconcile(0, policy, ctx.now);
    return { status: 'UNKNOWN', errorCode: 'MKT_ACTION_UNKNOWN', detail: sent.errorCode, dueAt: plan.nextAttemptAt, fields: { attempts, reconcile_attempts: 0 } };
  }
  // circuito aberto (deferred) segura como o limite do fornecedor: não gasta tentativa enquanto os adiamentos seguidos estiverem abaixo do parâmetro
  const plan = planRetry(counters(entry), { rateLimited: Boolean(sent.rateLimited || sent.deferred), retryAfterMs: sent.retryAfterMs }, policy, ctx.now);
  if (!plan.exhausted) return { status: 'RETRY', errorCode: sent.errorCode, dueAt: plan.nextAttemptAt, fields: { attempts: plan.attempts, rate_deferrals: plan.rateDeferrals, reconcile_attempts: 0 } };
  await settle(ctx, entry, 'FAILED', RETRY_CODES.RETRIES_EXHAUSTED);
  return { status: 'FAILED', errorCode: RETRY_CODES.RETRIES_EXHAUSTED, detail: sent.errorCode, fields: { attempts: plan.attempts, rate_deferrals: plan.rateDeferrals } };
}

/** Estouro do tempo da ação de envio (marketing.runner.acao_timeout_s): o canal pode ter recebido; vira UNKNOWN reconciliável, nunca reenvio às cegas. */
async function timedOutSend(ctx, entry) {
  const plan = planReconcile(0, await readDeliveryPolicy(ctx.tenant, ctx.transaction), ctx.now);
  return { ...entry, status: 'UNKNOWN', error_code: 'MKT_ACTION_UNKNOWN', detail: 'tempo esgotado', due_at: iso(plan.nextAttemptAt), attempts: counters(entry).attempts + 1, reconcile_attempts: 0 };
}

/** Consulta o provedor pela chave, num savepoint (uma falha não aborta a retomada da run). Sem resposta conclusiva: { error }. */
async function askProvider(ctx, entry) {
  try {
    return (await sequelize.transaction({ transaction: ctx.transaction }, (inner) => ports.reconcileMessage({ ...msgCtx(ctx, entry), transaction: inner }))) || { error: 'RECONCILE_EMPTY' };
  } catch (err) {
    logger.warn({ actionKey: entry.action_key, code: err && err.code }, 'marketing.runner.reconcile.failed');
    return { error: (err && err.code) || 'RECONCILE_EXCEPTION' };
  }
}

const auditReconciled = (ctx, runId, entry, found) => registrarAuditoria({
  groupId: ctx.tenant.groupId, companyId: ctx.tenant.companyId, actorUserId: null, action: 'marketing.automation_run.action.reconciled', entityType: 'MarketingAutomationRun', entityId: runId,
  beforeJson: { actionKey: entry.action_key, status: 'UNKNOWN', reconcileAttempts: Number(entry.reconcile_attempts || 0) }, afterJson: { actionKey: entry.action_key, found },
  reason: found ? 'O provedor confirmou a mensagem da automação: ação OK, sem reenvio.' : 'O provedor confirmou que não recebeu a mensagem da automação: segue para nova tentativa com a mesma chave.',
}, ctx.transaction);

/** A ação aberta fecha sem sair (motivo de bloqueio ou de aplicabilidade): SKIPPED, e a mensagem do CRM que estava na fila vira CANCELLED. */
async function closeWithoutSending(ctx, entry, reason) {
  await settle(ctx, entry, 'CANCELLED', reason);
  return { ...entry, status: 'SKIPPED', error_code: reason, due_at: null };
}

/** Nova tentativa na hora: kill switch e canSend inteiro (reevaluate do executor das ações adiadas). Bloqueio fecha a mensagem; silêncio só muda o due_at. */
async function retryNow(ctx, entry, reevaluate) {
  const next = await reevaluate({ ...entry, status: 'RETRY' });
  return next.status === 'SKIPPED' ? closeWithoutSending(ctx, entry, next.error_code) : next;
}

/** UNKNOWN vencido: consulta antes de tudo. `reason` (aplicabilidade) impede o reenvio, nunca a consulta. */
async function reconcileDue(ctx, entry, { reason, reevaluate, runId }) {
  const policy = await readDeliveryPolicy(ctx.tenant, ctx.transaction);
  const answer = await askProvider(ctx, entry);
  const done = Number(entry.reconcile_attempts || 0) + 1;
  if (answer.found) {
    await auditReconciled(ctx, runId, entry, true);
    return { ...entry, status: 'OK', provider_ref: answer.externalRef || entry.provider_ref || null, error_code: null, due_at: null, reconcile_attempts: done };
  }
  if (answer.notFound) {
    await auditReconciled(ctx, runId, entry, false);
    const base = { ...entry, reconcile_attempts: done, rate_deferrals: 0, error_code: RETRY_CODES.RECONCILED_NOT_FOUND };
    if (reason) return closeWithoutSending(ctx, base, reason);
    if (counters(entry).attempts >= policy.retry.max_attempts) { // tentativas já esgotadas: fecha FAILED, sem reenvio
      await settle(ctx, entry, 'FAILED', RETRY_CODES.RETRIES_EXHAUSTED);
      return { ...base, status: 'FAILED', error_code: RETRY_CODES.RETRIES_EXHAUSTED, detail: RETRY_CODES.RECONCILED_NOT_FOUND, due_at: null };
    }
    return retryNow(ctx, base, reevaluate);
  }
  const plan = planReconcile(done, policy, ctx.now);
  if (plan.exhausted) return { ...entry, status: 'FAILED', error_code: RETRY_CODES.UNKNOWN_EXHAUSTED, detail: answer.error, due_at: null, reconcile_attempts: done };
  return { ...entry, reconcile_attempts: done, due_at: iso(plan.nextAttemptAt), detail: answer.error };
}

/**
 * Retomada de UMA ação de envio aberta pelo executor das ações adiadas. `reason`: precondição que deixou de valer (fluxo pausado, contrato). `reevaluate(entry)`:
 * kill switch e canSend na hora (mesmo caminho da ação SCHEDULED). Ação ainda não vencida só fecha se o motivo de aplicabilidade apareceu (RETRY) e espera (UNKNOWN).
 */
async function followUpOpenSend(ctx, entry, { reason, reevaluate, runId }) {
  const due = Boolean(entry.due_at) && new Date(entry.due_at).getTime() <= ctx.now.getTime();
  if (entry.status === 'RETRY') {
    if (reason) return closeWithoutSending(ctx, entry, reason);
    return due ? retryNow(ctx, entry, reevaluate) : entry;
  }
  return due ? reconcileDue(ctx, entry, { reason, reevaluate, runId }) : entry;
}

module.exports = { resultOfSend, timedOutSend, followUpOpenSend };
