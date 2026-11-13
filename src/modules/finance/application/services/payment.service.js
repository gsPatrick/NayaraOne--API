'use strict';

/**
 * Pagamento (Guia M4 §2 payment.service; §3, §4, §5 e §7; Caderno §8 e §9). O PREPARE está em payment-prepare.service.js (reexportado
 * aqui); este arquivo aprova (cada aprovador é um passo do pedido que nasceu da regra REG-FIN-002; a intenção só fica APPROVED quando o nº
 * de aprovações exigido é atingido), executa (baixa manual pela intenção aprovada, com comprovante), cancela e confirma o pagamento
 * enviado ao banco. O envio ao banco em três fases está em bank-submission.service.js.
 *
 * Aprovar, executar e enviar reconferem o retrato aprovável (lançamento + valor + favorecido congelado) contra o estado ATUAL
 * (payment-snapshot.js): qualquer troca de conta/agência/banco/PIX/titular recusa (Caderno §9, FIN-TS-003).
 *
 * Confirmação (Guia §7; PROVIDER_BANCARIO.md §3.2): só cria ledger quando houver confirmação confiável do banco. B4 — CONFIRMED para
 * intenção FAILED abre anomalia; A2 — CONFIRMED para lançamento já liquidado vira anomalia; §8.12 — valor do banco diferente do aprovado
 * não confirma e abre anomaly_case.
 */
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const intents = require('../../infrastructure/repositories/payment-intent.repository');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const domain = require('../../domain/payment-intent');
const { OPEN_FOR_SETTLEMENT_STATUSES } = require('../../domain/financial-entry');
const { publishPaymentApproved, publishCadernoEvent } = require('./finance-events.service');
const { getFinancialEntry } = require('./financial-entry.service');
const { settleFinancialEntry, settleFinancialEntryPartial } = require('./receipt.service');
const { computeRemainingAmount } = require('./ledger-balance.service');
const { createAnomalyCase } = require('./anomaly-cases.service');
const { createPaymentIntent } = require('./payment-prepare.service');
const { assertStillApprovable } = require('./payment-snapshot');
const { approvalRequiresMfa } = require('./payment-approval-policy');
const workflow = require('./approval-workflow');
const bank = require('./bank-hub');

const { FINAL_FAILURE_STATUSES, RETURNED_STATUSES } = domain;

function audit(intent, actorUserId, action, beforeJson, reason, transaction) {
  return registrarAuditoria(
    { groupId: intent.groupId, companyId: intent.companyId, actorUserId, action, entityType: 'PaymentIntent', entityId: intent.id, beforeJson, afterJson: intent.toJSON(), reason },
    transaction
  );
}

async function getPaymentIntent(id, transaction) {
  const intent = await intents.findById(id, transaction);
  if (!intent) throw AppError.notFound('Intenção de pagamento não encontrada.', 'FINANCE_PAYMENT_INTENT_NOT_FOUND');
  return intent;
}

// Lock pessimista: duas execuções concorrentes liquidariam o lançamento duas vezes.
async function getPaymentIntentForUpdate(id, transaction) {
  const intent = await intents.findByIdForUpdate(id, transaction);
  if (!intent) throw AppError.notFound('Intenção de pagamento não encontrada.', 'FINANCE_PAYMENT_INTENT_NOT_FOUND');
  return intent;
}

/** Guia §5: a intenção vai a EXECUTING e o pedido de execução entra no outbox na mesma transação. */
async function markExecuting(intent, actorUserId, submissionPhase, transaction) {
  intent.status = 'EXECUTING';
  intent.submissionPhase = submissionPhase;
  intent.updatedBy = actorUserId || null;
  await intents.save(intent, transaction);
  await publishCadernoEvent('finance.payment.execution_requested', 'PaymentIntent', intent,
    { id: intent.id, financialEntryId: intent.financialEntryId, amount: intent.snapshotJson.amount, idempotencyKey: intent.idempotencyKey, channel: submissionPhase === 'NOT_STARTED' ? 'MANUAL' : 'BANK' },
    null, transaction);
}

/**
 * approvePaymentIntent — um aprovador registra a decisão no pedido que nasceu da regra (Guia §4 createFromRule). Recusa: quem preparou
 * (maker-checker), quem já aprovou, retrato divergente (lançamento ou favorecido mudou) e falta de MFA recente quando o risco exige
 * (HIGH/CRITICAL sempre; MEDIUM conforme parâmetro). A intenção só vira APPROVED quando o nº de aprovações exigido é atingido.
 */
async function approvePaymentIntent(id, actorUserId, transaction) {
  const intent = await getPaymentIntentForUpdate(id, transaction);
  if (!domain.canApprove(intent)) {
    throw AppError.conflict(`Só é possível aprovar uma intenção aguardando aprovação (atual: "${intent.status}").`, 'FINANCE_PAYMENT_INTENT_INVALID_STATUS');
  }
  if (domain.isSelfApproval(intent, actorUserId)) {
    throw AppError.forbidden(
      'Quem criou a intenção de pagamento não pode aprová-la (segregação de funções — maker-checker).',
      'FINANCE_PAYMENT_INTENT_SELF_APPROVAL_FORBIDDEN'
    );
  }
  await assertStillApprovable(intent, transaction, 'aprovar');
  const approval = intent.approvalRequestId ? await workflow.getApprovalForUpdate(intent.approvalRequestId, transaction) : null;
  if (!approval || approval.relatedEntityId !== intent.id || approval.snapshotHash !== intent.snapshotHash) {
    throw AppError.conflict('O pedido de aprovação desta intenção não corresponde ao retrato preparado.', 'FINANCE_PAYMENT_INTENT_STALE');
  }
  const requireMfa = await approvalRequiresMfa(approval.riskLevel, { groupId: intent.groupId, companyId: intent.companyId }, transaction);
  const decision = await workflow.recordDecision(approval, { decision: 'APPROVED', approverUserId: actorUserId, requireMfa }, transaction);

  const beforeJson = intent.toJSON();
  if (approval.status === 'APPROVED') {
    intent.status = 'APPROVED';
    intent.approvedByUserId = actorUserId || null;
    intent.approvedAt = new Date();
  }
  intent.updatedBy = actorUserId || null;
  await intents.save(intent, transaction);
  await audit(intent, actorUserId, approval.status === 'APPROVED' ? 'finance.payment_intent.approve' : 'finance.payment_intent.approval_recorded', beforeJson,
    approval.status === 'APPROVED'
      ? `Intenção de pagamento aprovada (${decision.approvedCount} de ${decision.required}, risco ${approval.riskLevel}) — retrato com o favorecido conferido (${intent.snapshotHash.slice(0, 12)}).`
      : `Aprovação registrada: ${decision.approvedCount} de ${decision.required} exigidas (risco ${approval.riskLevel}). A intenção segue aguardando aprovação.`,
    transaction);
  if (approval.status === 'APPROVED') await publishPaymentApproved(intent, transaction);
  intent.dataValues.approval = { id: approval.id, riskLevel: approval.riskLevel, requiredApprovals: decision.required, approvedCount: decision.approvedCount, riskSource: approval.riskSource };
  return intent;
}

/** Liquida o valor da intenção: o saldo inteiro de um lançamento sem baixa vai pela baixa integral; parcela ou saldo de parcial, pela parcial. */
async function settleIntentAmount(intent, actorUserId, transaction, options) {
  const entry = await entries.findByIdForUpdate(intent.financialEntryId, transaction);
  const amountCents = domain.toCents(String(intent.snapshotJson.amount));
  const remainingCents = domain.toCents(await computeRemainingAmount(entry, transaction));
  const settleOptions = { viaApprovedPaymentIntent: true, paymentIntent: intent, idempotencyKey: intent.idempotencyKey, ...options };
  if (entry.status === 'PENDING' && amountCents === remainingCents && remainingCents === domain.toCents(String(entry.amount))) {
    return settleFinancialEntry(entry.id, actorUserId, transaction, settleOptions);
  }
  const result = await settleFinancialEntryPartial(entry.id, intent.snapshotJson.amount, actorUserId, transaction, settleOptions);
  return result.original;
}

/**
 * executePaymentIntent — Guia §5: se a execução já aconteceu (mesma chave de idempotência), devolve o resultado existente (FIN-TS-002: a
 * execução perdedora de uma corrida é replay, não erro). Só executa a partir de APPROVED e com o retrato ainda válido. F03 — execução
 * MANUAL é baixa manual com comprovante + motivo; o caminho com o banco é bank-submission.prepareBankSubmission -> confirmBankPayment.
 */
async function executePaymentIntent(id, actorUserId, transaction, options = {}) {
  const intent = await getPaymentIntentForUpdate(id, transaction);
  if (intent.status === 'CONFIRMED') {
    const entry = await getFinancialEntry(intent.financialEntryId, transaction);
    return { intent, entry, replayed: true };
  }
  if (!domain.canExecute(intent)) {
    throw AppError.conflict(`Só é possível executar uma intenção APPROVED (atual: "${intent.status}").`, 'FINANCE_PAYMENT_INTENT_NOT_APPROVED');
  }
  await assertStillApprovable(intent, transaction, 'executar');
  const beforeJson = intent.toJSON();
  // As travas da baixa (comprovante, aprovação depois do comprovante, período, revisão) rodam antes de a intenção mudar de estado: uma
  // recusa deixa a intenção APPROVED, sem pedido de execução no outbox.
  const settled = await settleIntentAmount(intent, actorUserId, transaction, { manualSettlement: options.manualSettlement || null });
  await markExecuting(intent, actorUserId, 'NOT_STARTED', transaction);
  intent.status = 'CONFIRMED';
  intent.executedAt = new Date();
  intent.updatedBy = actorUserId || null;
  await intents.save(intent, transaction);
  await audit(intent, actorUserId, 'finance.payment_intent.execute', beforeJson,
    `Intenção de pagamento executada — R$ ${intent.snapshotJson.amount} baixados no lançamento ${settled.id} conforme o retrato aprovado.`, transaction);
  return { intent, entry: settled };
}

async function cancelPaymentIntent(id, reasonText, actorUserId, transaction) {
  const intent = await getPaymentIntentForUpdate(id, transaction);
  // EXECUTING também é bloqueado: cancelar e deixar o banco confirmar depois criaria uma divergência silenciosa.
  if (!domain.canCancel(intent)) {
    throw AppError.conflict(`Intenção com status "${intent.status}" não pode ser cancelada.`, 'FINANCE_PAYMENT_INTENT_INVALID_STATUS');
  }
  const beforeJson = intent.toJSON();
  intent.status = 'CANCELED';
  intent.cancelledAt = new Date();
  intent.cancelReason = reasonText ? String(reasonText).trim() : null;
  intent.updatedBy = actorUserId || null;
  await intents.save(intent, transaction);
  if (intent.approvalRequestId) {
    const approval = await workflow.getApprovalForUpdate(intent.approvalRequestId, transaction).catch(() => null);
    if (approval) await workflow.markStale(approval, 'Intenção de pagamento cancelada.', actorUserId, transaction);
  }
  await audit(intent, actorUserId, 'finance.payment_intent.cancel', beforeJson,
    intent.cancelReason ? `Intenção de pagamento cancelada: ${intent.cancelReason}` : 'Intenção de pagamento cancelada.', transaction);
  return intent;
}

/** Progresso da aprovação de cada intenção (risco, exigidas, quem já aprovou) para a tela. */
async function withApprovalInfo(list, transaction) {
  for (const intent of list) {
    if (!intent.approvalRequestId) continue;
    const approval = await require('./approvals.service').getApprovalRequest(intent.approvalRequestId, transaction).catch(() => null);
    if (!approval || approval.relatedEntityType !== 'PaymentIntent') continue;
    const approvers = await workflow.listApprovers(approval.id, transaction);
    intent.dataValues.approval = {
      id: approval.id, status: approval.status, riskLevel: approval.riskLevel, riskSource: approval.riskSource, ruleVersionId: approval.ruleVersionId,
      requiredApprovals: workflow.requiredApprovalsOf(approval), approvedCount: approvers.filter((a) => a.decision === 'APPROVED').length, approvers,
    };
  }
  return list;
}

async function listPaymentIntents(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.financialEntryId) where.financialEntryId = filters.financialEntryId;
  return withApprovalInfo(await intents.list(where, transaction), transaction);
}

function openAnomaly(intent, caseType, riskLevel, reason, transaction) {
  return createAnomalyCase({ groupId: intent.groupId, companyId: intent.companyId, caseType, riskLevel, relatedEntityType: 'PaymentIntent', relatedEntityId: intent.id, reason }, null, transaction);
}

/** §8.12 — valor confirmado diferente do aprovado: um caso aberto por intenção (as repetições do banco não abrem outro). */
async function openAmountMismatchAnomaly(intent, informed, transaction) {
  const open = await intents.findOpenAnomaly(intent.id, 'BANK_AMOUNT_MISMATCH', transaction);
  if (open) return open;
  return openAnomaly(intent, 'BANK_AMOUNT_MISMATCH', 'CRITICAL',
    `O banco informou R$ ${informed ?? '(sem valor)'} para o pagamento aprovado de R$ ${intent.snapshotJson.amount}: o pagamento não foi confirmado e precisa de revisão.`, transaction);
}

// Chamado por webhook, polling ou reconciliação (todos idempotentes — PROVIDER_BANCARIO.md §3.3).
async function confirmBankPayment(externalSubmissionId, externalStatus, transaction, options = {}) {
  const routing = await intents.findRouting(externalSubmissionId, transaction);
  if (!routing) throw AppError.notFound('Nenhuma intenção de pagamento encontrada para este id externo.', 'FINANCE_BANK_PAYMENT_ROUTING_NOT_FOUND');
  const intent = await getPaymentIntentForUpdate(routing.paymentIntentId, transaction);
  const rawStatus = domain.normalizeStatus(externalStatus);
  const status = bank.isPaidStatus(rawStatus) ? 'CONFIRMED' : rawStatus; // PAID, SETTLED e COMPLETED são o mesmo "pago"
  const beforeJson = intent.toJSON();

  if (intent.status === 'FAILED' && status === 'CONFIRMED') {
    intent.externalStatus = status;
    await intents.save(intent, transaction);
    await openAnomaly(intent, 'LATE_BANK_CONFIRMATION', 'HIGH', `O banco confirmou o pagamento ${externalSubmissionId} depois de ele ter sido dado como falho — verificar pagamento em dobro e reconciliar.`, transaction);
    await audit(intent, null, 'finance.payment_intent.late_confirmation', beforeJson, 'Confirmação do banco após falha — caso de anomalia aberto.', transaction);
    return intent;
  }
  if (intent.status === 'CONFIRMED' && RETURNED_STATUSES.includes(status)) {
    intent.externalStatus = status;
    await intents.save(intent, transaction);
    await openAnomaly(intent, 'BANK_PAYMENT_RETURNED', 'HIGH', `O banco informou devolução (${status}) de um pagamento já confirmado (${externalSubmissionId}) — o lançamento continua liquidado; registrar o estorno/recebimento da devolução.`, transaction);
    return intent;
  }
  if (!domain.isInFlight(intent)) return intent;

  if (status === 'CONFIRMED') {
    const check = await bank.checkAmount(intent, options.amount, transaction);
    if (!check.ok) {
      await bank.rejectByAmount(intent, check, options.source, transaction);
      await openAmountMismatchAnomaly(intent, options.amount, transaction);
      intent.bankMismatch = true;
      return intent;
    }
  }
  intent.externalStatus = status;
  if (status === 'CONFIRMED') {
    const entry = await entries.findByIdForUpdate(intent.financialEntryId, transaction);
    const remainingCents = entry ? /** @type {number} */ (domain.toCents(await computeRemainingAmount(entry, transaction))) : 0;
    if (!entry || !OPEN_FOR_SETTLEMENT_STATUSES.includes(entry.status) || remainingCents < /** @type {number} */ (domain.toCents(String(intent.snapshotJson.amount)))) {
      // A2 — o lançamento já foi liquidado por outro caminho: o banco pagou de novo.
      intent.status = 'CONFIRMED';
      intent.executedAt = new Date();
      intent.uncertainSince = null;
      await intents.save(intent, transaction);
      await bank.applyStatusToDispatch(intent, rawStatus, options.source, transaction);
      await openAnomaly(intent, 'DUPLICATE_SETTLEMENT', 'HIGH', `O banco confirmou o pagamento ${externalSubmissionId}, mas o lançamento já estava ${entry ? entry.status : 'inexistente'} sem saldo para ele — possível pagamento em dobro.`, transaction);
      return intent;
    }
    const settled = await settleIntentAmount(intent, null, transaction, { viaBankConfirmation: true, sandboxConfirmation: Boolean(options.sandbox) });
    intent.status = 'CONFIRMED';
    intent.executedAt = new Date();
    intent.uncertainSince = null;
    await intents.save(intent, transaction);
    await bank.applyStatusToDispatch(intent, rawStatus, options.source, transaction);
    await audit(intent, null, 'finance.payment_intent.confirm_bank_payment', beforeJson, `Pagamento confirmado pelo ${options.sandbox ? 'provedor SANDBOX (simulação)' : 'banco'} — R$ ${intent.snapshotJson.amount} baixados no lançamento ${settled.id}.`, transaction);
  } else if (FINAL_FAILURE_STATUSES.includes(status)) {
    intent.status = 'FAILED';
    intent.failedAt = new Date();
    intent.uncertainSince = null;
    intent.failureReason = `Status retornado pelo banco: ${status}`;
    await intents.save(intent, transaction);
    await bank.applyStatusToDispatch(intent, rawStatus, options.source, transaction);
    await audit(intent, null, 'finance.payment_intent.bank_payment_failed', beforeJson, `Pagamento recusado/falhou no banco — status "${status}".`, transaction);
  } else {
    await intents.save(intent, transaction);
    await audit(intent, null, 'finance.payment_intent.bank_payment_pending', beforeJson, `Banco respondeu "${status}" (não final) — pagamento continua em trânsito, sem liquidação e sem liberar novo pagamento.`, transaction);
  }
  return intent;
}

module.exports = {
  createPaymentIntent,
  approvePaymentIntent,
  executePaymentIntent,
  cancelPaymentIntent,
  listPaymentIntents,
  getPaymentIntent,
  getPaymentIntentForUpdate,
  confirmBankPayment,
  markExecuting,
  withApprovalInfo,
};
