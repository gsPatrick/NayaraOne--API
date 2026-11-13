'use strict';

/**
 * Pagamento (Guia M4 §2 payment.service; §3 e §4; Caderno §8 e §9): preparar (intenção com retrato e hash),
 * aprovar (maker-checker conferindo o hash contra o estado atual), executar (baixa manual pela intenção
 * aprovada), cancelar e confirmar o pagamento enviado ao banco. O envio ao banco em três fases, a reconciliação
 * e a saída controlada da incerteza estão em bank-submission.service.js. A regra pura (estados, retrato e hash)
 * está em domain/payment-intent.js e o acesso a dados em infrastructure/repositories/payment-intent.repository.js.
 *
 * M4-07 — o lock otimista (`lock_version`) da aprovação detecta "mudou desde que eu revisei", mas não guarda O QUE
 * foi revisado. A intenção congela uma CÓPIA dos campos que importam para pagar e o SHA-256 dessa cópia
 * (03_MOTORES_TRANSVERSAIS.md: "quem executa valida o hash aprovado"): se um único campo mudou depois do
 * retrato, aprovar ou executar é RECUSADO, com prova do que mudou.
 *
 * Confirmação (PROVIDER_BANCARIO.md §3.2): "Só cria ledger quando houver confirmação confiável do banco" /
 * "sistema nunca presume sucesso". B4 — CONFIRMED para intenção já FAILED abre caso de anomalia; B5 — confirmação
 * do sandbox fica SANDBOX_CONFIRMED; A2 — CONFIRMED para lançamento já liquidado vira anomalia (pagamento em dobro).
 */
const crypto = require('node:crypto');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const intents = require('../../infrastructure/repositories/payment-intent.repository');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const domain = require('../../domain/payment-intent');
const { publishPaymentPrepared, publishPaymentApproved } = require('./finance-events.service');
const { getFinancialEntry } = require('./financial-entry.service');
const { settleFinancialEntry } = require('./receipt.service');
const { isApprovalRequestApproved, getApprovalRequest } = require('./approvals.service');
const { createAnomalyCase } = require('./anomaly-cases.service');
const bank = require('./bank-hub');

const { buildEntrySnapshot, computeSnapshotHash, OPEN_STATUSES, FINAL_FAILURE_STATUSES, RETURNED_STATUSES } = domain;

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

// Variante com lock pessimista: no executePaymentIntent duas chamadas concorrentes liquidariam o lançamento duas vezes.
async function getPaymentIntentForUpdate(id, transaction) {
  const intent = await intents.findByIdForUpdate(id, transaction);
  if (!intent) throw AppError.notFound('Intenção de pagamento não encontrada.', 'FINANCE_PAYMENT_INTENT_NOT_FOUND');
  return intent;
}

async function createPaymentIntent(payload, actorUserId, transaction) {
  const { financialEntryId, approvalRequestId } = payload;
  if (!financialEntryId) {
    throw AppError.badRequest('Escolha o lançamento para criar a intenção de pagamento.', 'FINANCE_PAYMENT_INTENT_VALIDATION');
  }
  // Relê o lançamento do banco para que o snapshot represente o estado PERSISTIDO. B3 (revisão independente):
  // sem lock no lançamento, duas requisições simultâneas criavam duas intenções (pagamento em dobro). O lock
  // serializa; o índice único parcial payment_intents_one_open_per_entry é a garantia final.
  const entry = await entries.findByIdForUpdate(financialEntryId, transaction);
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  if (entry.status !== 'PENDING') {
    throw AppError.conflict(
      `Só é possível criar intenção de pagamento para um lançamento PENDING (atual: "${entry.status}").`,
      'FINANCE_PAYMENT_INTENT_INVALID_ENTRY_STATUS'
    );
  }
  // §17: pagamento ainda não avaliado pelo antifraude é avaliado aqui (fica retido até a revisão humana).
  await require('./payment-anomaly-gate').evaluateAndAssertPreparable(entry, transaction, actorUserId); // DEC-007: achado bloqueante não vira intenção (o caso fica gravado: DI-DEC007-5)

  // F06-PAY-04/06 (conferência 18/10/2026): SUBMITTED também é intenção em aberto — o pagamento está em trânsito no banco.
  const existing = await intents.findOneForEntry(financialEntryId, OPEN_STATUSES, transaction);
  if (existing) {
    throw AppError.conflict('Já existe uma intenção de pagamento em aberto para este lançamento.', 'FINANCE_PAYMENT_INTENT_ALREADY_OPEN', { existingId: existing.id });
  }

  if (approvalRequestId) {
    const approvalRequest = await getApprovalRequest(approvalRequestId, transaction);
    if (approvalRequest.relatedEntityId !== entry.id) {
      throw AppError.badRequest('A solicitação de aprovação informada não se refere a este lançamento.', 'FINANCE_PAYMENT_INTENT_VALIDATION');
    }
  }

  const snapshot = buildEntrySnapshot(entry);
  let intent;
  try {
    // §8.4 "Cria payment_intent + snapshot/hash + idempotency_key": a chave nasce aqui, estável e
    // única por intenção; o envio ao banco reaproveita a mesma (bank-submission.prepareBankSubmission).
    const intentId = crypto.randomUUID();
    intent = await intents.create(
      {
        id: intentId,
        idempotencyKey: domain.idempotencyKeyFor(intentId),
        groupId: entry.groupId,
        companyId: entry.companyId,
        financialEntryId: entry.id,
        snapshotJson: snapshot,
        snapshotHash: computeSnapshotHash(snapshot),
        status: 'PENDING',
        approvalRequestId: approvalRequestId || null,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      transaction
    );
  } catch (err) {
    if (err && err.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict('Já existe uma intenção de pagamento em aberto para este lançamento.', 'FINANCE_PAYMENT_INTENT_ALREADY_OPEN');
    }
    throw err;
  }

  await audit(intent, actorUserId, 'finance.payment_intent.create', undefined,
    `Intenção de pagamento criada para o lançamento ${entry.id} (${snapshot.amount}) — snapshot ${intent.snapshotHash.slice(0, 12)}.`, transaction);
  await publishPaymentPrepared(intent, transaction);
  return intent;
}

/**
 * approvePaymentIntent — recalcula o hash sobre o estado ATUAL do lançamento e compara com o gravado
 * (divergiu = FINANCE_PAYMENT_INTENT_STALE). Maker-checker: quem criou não aprova. Intenção amarrada a uma
 * ApprovalRequest exige essa solicitação APPROVED — a intenção complementa a dupla aprovação com a prova do conteúdo.
 */
async function approvePaymentIntent(id, actorUserId, transaction) {
  const intent = await getPaymentIntentForUpdate(id, transaction);
  if (!domain.canApprove(intent)) {
    throw AppError.conflict(`Só é possível aprovar uma intenção PENDING (atual: "${intent.status}").`, 'FINANCE_PAYMENT_INTENT_INVALID_STATUS');
  }
  if (domain.isSelfApproval(intent, actorUserId)) {
    throw AppError.forbidden(
      'Quem criou a intenção de pagamento não pode aprová-la (segregação de funções — maker-checker).',
      'FINANCE_PAYMENT_INTENT_SELF_APPROVAL_FORBIDDEN'
    );
  }

  const entry = await getFinancialEntry(intent.financialEntryId, transaction);
  const currentSnapshot = buildEntrySnapshot(entry);
  const currentHash = computeSnapshotHash(currentSnapshot);
  if (currentHash !== intent.snapshotHash) {
    const changedFields = domain.changedSnapshotFields(currentSnapshot, intent.snapshotJson);
    throw AppError.conflict(
      `O lançamento foi alterado depois que esta intenção de pagamento foi criada (campos divergentes: ${changedFields.join(', ') || 'desconhecidos'}) — aprovação recusada por segurança. Crie uma nova intenção sobre os dados atuais.`,
      'FINANCE_PAYMENT_INTENT_STALE',
      { expectedHash: intent.snapshotHash, currentHash, changedFields }
    );
  }
  if (intent.approvalRequestId) {
    const approved = await isApprovalRequestApproved('FinancialEntry', intent.financialEntryId, transaction);
    if (!approved) {
      throw AppError.conflict('A solicitação de aprovação vinculada a esta intenção ainda não foi aprovada (maker-checker pendente).', 'FINANCE_PAYMENT_INTENT_APPROVAL_PENDING');
    }
  }

  const beforeJson = intent.toJSON();
  intent.status = 'APPROVED';
  intent.approvedByUserId = actorUserId || null;
  intent.approvedAt = new Date();
  intent.updatedBy = actorUserId || null;
  await intents.save(intent, transaction);
  await audit(intent, actorUserId, 'finance.payment_intent.approve', beforeJson,
    `Intenção de pagamento aprovada — hash do snapshot conferido contra o estado atual do lançamento (${intent.snapshotHash.slice(0, 12)}).`, transaction);
  await publishPaymentApproved(intent, transaction);
  return intent;
}

/**
 * executePaymentIntent — só executa a partir de APPROVED, e reconfere o hash uma última vez. F03 — execução
 * MANUAL (sem passar pelo banco) é baixa manual e exige comprovante + motivo; o caminho com confirmação
 * bancária é bank-submission.submitPaymentIntentToBank -> confirmBankPayment.
 */
async function executePaymentIntent(id, actorUserId, transaction, options = {}) {
  const intent = await getPaymentIntentForUpdate(id, transaction);
  if (!domain.canExecute(intent)) {
    throw AppError.conflict(`Só é possível executar uma intenção APPROVED (atual: "${intent.status}").`, 'FINANCE_PAYMENT_INTENT_NOT_APPROVED');
  }
  const entry = await getFinancialEntry(intent.financialEntryId, transaction);
  const currentHash = domain.currentEntryHash(entry);
  if (currentHash !== intent.snapshotHash) {
    throw AppError.conflict(
      'O lançamento foi alterado entre a aprovação e a execução desta intenção — execução recusada por segurança.',
      'FINANCE_PAYMENT_INTENT_STALE',
      { expectedHash: intent.snapshotHash, currentHash }
    );
  }
  const settled = await settleFinancialEntry(intent.financialEntryId, actorUserId, transaction, {
    viaApprovedPaymentIntent: true,
    paymentIntent: intent,
    manualSettlement: options.manualSettlement || null,
  });
  const beforeJson = intent.toJSON();
  intent.status = 'EXECUTED';
  intent.executedAt = new Date();
  intent.updatedBy = actorUserId || null;
  await intents.save(intent, transaction);
  await audit(intent, actorUserId, 'finance.payment_intent.execute', beforeJson,
    `Intenção de pagamento executada — lançamento ${settled.id} liquidado conforme o snapshot aprovado.`, transaction);
  return { intent, entry: settled };
}

async function cancelPaymentIntent(id, reasonText, actorUserId, transaction) {
  const intent = await getPaymentIntentForUpdate(id, transaction);
  // SUBMITTED também é bloqueado: cancelar e deixar o webhook do banco confirmar depois criaria uma
  // divergência silenciosa (dinheiro sai do banco, lançamento nunca liquida no ERP).
  if (!domain.canCancel(intent)) {
    throw AppError.conflict(`Intenção com status "${intent.status}" não pode ser cancelada.`, 'FINANCE_PAYMENT_INTENT_INVALID_STATUS');
  }
  const beforeJson = intent.toJSON();
  intent.status = 'CANCELLED';
  intent.cancelledAt = new Date();
  intent.cancelReason = reasonText ? String(reasonText).trim() : null;
  intent.updatedBy = actorUserId || null;
  await intents.save(intent, transaction);
  await audit(intent, actorUserId, 'finance.payment_intent.cancel', beforeJson,
    intent.cancelReason ? `Intenção de pagamento cancelada: ${intent.cancelReason}` : 'Intenção de pagamento cancelada.', transaction);
  return intent;
}

async function listPaymentIntents(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.financialEntryId) where.financialEntryId = filters.financialEntryId;
  return intents.list(where, transaction);
}

function openAnomaly(intent, caseType, riskLevel, reason, transaction) {
  return createAnomalyCase({ groupId: intent.groupId, companyId: intent.companyId, caseType, riskLevel, relatedEntityType: 'PaymentIntent', relatedEntityId: intent.id, reason }, null, transaction);
}

// Chamado por webhook, polling ou reconciliação (todos idempotentes — PROVIDER_BANCARIO.md §3.3).
async function confirmBankPayment(externalSubmissionId, externalStatus, transaction, options = {}) {
  const routing = await intents.findRouting(externalSubmissionId, transaction);
  if (!routing) throw AppError.notFound('Nenhuma intenção de pagamento encontrada para este id externo.', 'FINANCE_BANK_PAYMENT_ROUTING_NOT_FOUND');
  const intent = await getPaymentIntentForUpdate(routing.paymentIntentId, transaction);
  const rawStatus = domain.normalizeStatus(externalStatus);
  const status = bank.isPaidStatus(rawStatus) ? 'CONFIRMED' : rawStatus; // PAID, SETTLED e COMPLETED são o mesmo "pago" para o Financeiro
  const beforeJson = intent.toJSON();

  if (intent.status === 'FAILED' && status === 'CONFIRMED') {
    // B4 — confirmação tardia de uma tentativa dada como falha: o dinheiro pode ter saído. Nunca ignorar em silêncio.
    intent.externalStatus = status;
    await intents.save(intent, transaction);
    await openAnomaly(intent, 'LATE_BANK_CONFIRMATION', 'HIGH', `O banco confirmou o pagamento ${externalSubmissionId} depois de ele ter sido dado como falho — verificar pagamento em dobro e reconciliar.`, transaction);
    await audit(intent, null, 'finance.payment_intent.late_confirmation', beforeJson, 'Confirmação do banco após falha — caso de anomalia aberto.', transaction);
    return intent;
  }
  if (intent.status === 'EXECUTED' && RETURNED_STATUSES.includes(status)) {
    intent.externalStatus = status;
    await intents.save(intent, transaction);
    await openAnomaly(intent, 'BANK_PAYMENT_RETURNED', 'HIGH', `O banco informou devolução (${status}) de um pagamento já confirmado (${externalSubmissionId}) — o lançamento continua liquidado; registrar o estorno/recebimento da devolução.`, transaction);
    return intent;
  }
  if (!domain.isInFlight(intent)) return intent;

  if (status === 'CONFIRMED') {
    // M9-D237: o valor do status final precisa conferir com o aprovado (centavos); divergência não confirma e abre revisão humana (erro CRITICAL).
    const check = await bank.checkAmount(intent, options.amount, transaction);
    if (!check.ok) {
      await bank.rejectByAmount(intent, check, options.source, transaction);
      intent.bankMismatch = true;
      return intent;
    }
  }
  intent.externalStatus = status;
  if (status === 'CONFIRMED') {
    const entry = await entries.findByIdForUpdate(intent.financialEntryId, transaction);
    if (!entry || entry.status !== 'PENDING') {
      // A2 — o lançamento já foi liquidado por outro caminho: o banco pagou de novo.
      intent.status = 'EXECUTED';
      intent.executedAt = new Date();
      intent.uncertainSince = null;
      await intents.save(intent, transaction);
      await bank.applyStatusToDispatch(intent, rawStatus, options.source, transaction);
      await openAnomaly(intent, 'DUPLICATE_SETTLEMENT', 'HIGH', `O banco confirmou o pagamento ${externalSubmissionId}, mas o lançamento já estava ${entry ? entry.status : 'inexistente'} — possível pagamento em dobro.`, transaction);
      return intent;
    }
    const settled = await settleFinancialEntry(intent.financialEntryId, null, transaction, {
      viaApprovedPaymentIntent: true,
      viaBankConfirmation: true,
      sandboxConfirmation: Boolean(options.sandbox),
      paymentIntent: intent,
    });
    intent.status = 'EXECUTED';
    intent.executedAt = new Date();
    intent.uncertainSince = null;
    await intents.save(intent, transaction);
    await bank.applyStatusToDispatch(intent, rawStatus, options.source, transaction);
    await audit(intent, null, 'finance.payment_intent.confirm_bank_payment', beforeJson, `Pagamento confirmado pelo ${options.sandbox ? 'provedor SANDBOX (simulação)' : 'banco'} — lançamento ${settled.id} liquidado.`, transaction);
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
};
