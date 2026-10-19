'use strict';

const { PaymentIntent, BankAccount, BankPaymentProviderRouting, FinancialEntry } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { resolveBankAdapter } = require('./adapters/resolveBankAdapter');
const { getPaymentIntentForUpdate } = require('./paymentIntents.service');
const { settleFinancialEntry } = require('./financialEntries.service');
const { assertBankAccountEligibleForPayment } = require('./financeAntifraud.service');
const { createAnomalyCase } = require('./anomalyCases.service');

// Caminho de submissão bancária real (PROVIDER_BANCARIO.md §3.2): "Só cria ledger quando houver
// confirmação confiável do banco" / "sistema nunca presume sucesso". Só confirmBankPayment
// (webhook, polling ou reconciliação) liquida — e só com status CONFIRMED.
//
// REVISÃO INDEPENDENTE (conferência Nayara 18/10/2026):
//   B1 — a chamada externa acontecia dentro da transação: se o commit falhasse depois que o
//        banco aceitou, o pagamento existia no banco sem registro local, e a nova tentativa
//        pagaria de novo. Agora a submissão tem 3 fases (prepareBankSubmission grava SUBMITTING
//        e COMMITA; a chamada ao banco roda fora de transação levando a chave de idempotência;
//        finalizeBankSubmission grava o resultado). Erro/timeout na chamada deixa a intenção
//        SUBMITTING (incerta) — nunca FAILED, nunca liberada para outra intenção.
//   B2 — reconcilePaymentIntent (job e ação manual) consulta o banco para intenções incertas;
//        resolveUncertainPaymentIntent é a saída controlada (motivo + auditoria).
//   B4 — CONFIRMED chegando para intenção já FAILED (dinheiro pode ter saído duas vezes) abre
//        caso de anomalia em vez de ser ignorado.
//   B5 — confirmação via provedor sandbox fica gravada como SANDBOX_CONFIRMED.
//   B6 — confirmação não é recusada por controles de pré-pagamento (ver financialEntries).
//   A2 — CONFIRMED para lançamento já liquidado vira anomalia (pagamento em dobro), não erro em loop.

// ERROR não é final (costuma ser transitório). RETURNED é tratado à parte (devolução depois de pago).
const FINAL_FAILURE_STATUSES = ['REJECTED', 'FAILED', 'CANCELLED', 'CANCELED', 'DENIED', 'EXPIRED'];
const RETURNED_STATUSES = ['RETURNED', 'REVERSED', 'REFUNDED'];

function normalizeStatus(status) {
  return String(status || '').trim().toUpperCase();
}

async function openAnomaly(intent, caseType, riskLevel, reason, transaction) {
  return createAnomalyCase(
    {
      groupId: intent.groupId,
      companyId: intent.companyId,
      caseType,
      riskLevel,
      relatedEntityType: 'PaymentIntent',
      relatedEntityId: intent.id,
      reason,
    },
    null,
    transaction
  );
}

/** Fase 1 — valida e grava SUBMITTING (o chamador deve COMMITAR antes de chamar o banco). */
async function prepareBankSubmission(id, paymentMethod, actor, transaction) {
  const intent = await getPaymentIntentForUpdate(id, transaction);
  if (intent.status !== 'APPROVED') {
    throw AppError.conflict(
      `Só é possível submeter ao banco uma intenção APPROVED (atual: "${intent.status}").`,
      'FINANCE_PAYMENT_INTENT_NOT_APPROVED'
    );
  }
  const bankAccountId = intent.snapshotJson?.bankAccountId;
  if (!bankAccountId) {
    throw AppError.badRequest('O lançamento desta intenção não tem conta bancária de destino definida.', 'FINANCE_BANK_PAYMENT_NO_BANK_ACCOUNT');
  }
  const bankAccount = await BankAccount.findByPk(bankAccountId, { transaction });
  if (!bankAccount) throw AppError.notFound('Conta bancária não encontrada.', 'FINANCE_BANK_ACCOUNT_NOT_FOUND');
  await assertBankAccountEligibleForPayment(bankAccount.id, transaction);
  if (paymentMethod === 'PIX' && !bankAccount.pixKey) {
    throw AppError.badRequest('A conta bancária de destino não tem chave PIX cadastrada.', 'FINANCE_BANK_PAYMENT_MISSING_PIX_KEY');
  }
  // Resolve o adapter já aqui: configuração incompleta falha ANTES de qualquer estado mudar.
  const adapter = await resolveBankAdapter({ groupId: intent.groupId, companyId: intent.companyId }, transaction);

  const beneficiarySnapshot = {
    personId: bankAccount.ownerPersonId || null,
    name: intent.snapshotJson?.description || null,
    bankCode: bankAccount.bankCode || null,
    branch: bankAccount.agency || null,
    account: bankAccount.accountNumber || null,
    pixKey: bankAccount.pixKey || null,
  };
  const beforeJson = intent.toJSON();
  intent.bankAccountId = bankAccountId;
  intent.beneficiarySnapshot = beneficiarySnapshot;
  intent.paymentMethod = paymentMethod;
  intent.idempotencyKey = `payment-intent:${intent.id}`;
  intent.status = 'SUBMITTING';
  intent.uncertainSince = new Date();
  intent.updatedBy = actor.userId || null;
  await intent.save({ transaction });
  await registrarAuditoria(
    {
      groupId: intent.groupId, companyId: intent.companyId, actorUserId: actor.userId,
      action: 'finance.payment_intent.submitting', entityType: 'PaymentIntent', entityId: intent.id,
      beforeJson, afterJson: intent.toJSON(),
      reason: `Envio ao banco iniciado via ${paymentMethod} — chave de idempotência ${intent.idempotencyKey}.`,
    },
    transaction
  );
  return { intent, adapter, request: buildSubmitRequest(intent) };
}

function buildSubmitRequest(intent) {
  return {
    paymentMethod: intent.paymentMethod,
    idempotencyKey: intent.idempotencyKey,
    amount: intent.snapshotJson?.amount,
    providerPayload: { amount: intent.snapshotJson?.amount, beneficiary: intent.beneficiarySnapshot },
  };
}

/** Fase 2 — chamada ao banco, FORA de transação. Nunca lança: devolve o resultado. */
async function callBankSubmit(adapter, request) {
  try {
    const submission = await adapter.submitPayment(request);
    if (!submission || !submission.externalId) {
      return { ok: false, error: 'Resposta do banco sem identificador do pagamento.' };
    }
    return { ok: true, externalId: submission.externalId, status: submission.status };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/** Fase 3 — grava o resultado da chamada. */
async function finalizeBankSubmission(id, result, actor, transaction) {
  const intent = await getPaymentIntentForUpdate(id, transaction);
  if (intent.status !== 'SUBMITTING') return intent;
  const beforeJson = intent.toJSON();
  if (!result.ok) {
    intent.externalStatus = 'UNCERTAIN';
    intent.failureReason = `Resposta do banco incerta: ${result.error}. A intenção fica em envio incerto até a reconciliação consultar o banco.`;
    intent.updatedBy = actor.userId || null;
    await intent.save({ transaction });
    await registrarAuditoria(
      {
        groupId: intent.groupId, companyId: intent.companyId, actorUserId: actor.userId,
        action: 'finance.payment_intent.submission_uncertain', entityType: 'PaymentIntent', entityId: intent.id,
        beforeJson, afterJson: intent.toJSON(), reason: intent.failureReason,
      },
      transaction
    );
    return intent;
  }
  intent.externalSubmissionId = result.externalId;
  intent.externalStatus = result.status || null;
  intent.status = 'SUBMITTED';
  intent.submittedAt = new Date();
  intent.failureReason = null;
  intent.updatedBy = actor.userId || null;
  await intent.save({ transaction });
  const existingRouting = await BankPaymentProviderRouting.findOne({ where: { externalSubmissionId: result.externalId }, transaction });
  if (!existingRouting) {
    await BankPaymentProviderRouting.create(
      { externalSubmissionId: result.externalId, paymentIntentId: intent.id, groupId: intent.groupId, companyId: intent.companyId },
      { transaction }
    );
  }
  await registrarAuditoria(
    {
      groupId: intent.groupId, companyId: intent.companyId, actorUserId: actor.userId,
      action: 'finance.payment_intent.submit_to_bank', entityType: 'PaymentIntent', entityId: intent.id,
      beforeJson, afterJson: intent.toJSON(),
      reason: `Pagamento submetido ao banco via ${intent.paymentMethod} — id externo ${result.externalId}.`,
    },
    transaction
  );
  return intent;
}

/**
 * submitPaymentIntentToBank — as 3 fases numa única transação. Usado por chamadores que já
 * estão dentro de uma transação (testes de serviço). A rota HTTP usa as 3 fases em transações
 * separadas (finance.controller.js), que é o caminho seguro contra queda entre banco e commit.
 */
async function submitPaymentIntentToBank(id, paymentMethod, actor, transaction) {
  const { adapter, request } = await prepareBankSubmission(id, paymentMethod, actor, transaction);
  const result = await callBankSubmit(adapter, request);
  return finalizeBankSubmission(id, result, actor, transaction);
}

// Chamado por webhook, polling ou reconciliação (todos idempotentes — PROVIDER_BANCARIO.md §3.3).
async function confirmBankPayment(externalSubmissionId, externalStatus, transaction, options = {}) {
  const routing = await BankPaymentProviderRouting.findOne({ where: { externalSubmissionId }, transaction });
  if (!routing) {
    throw AppError.notFound('Nenhuma intenção de pagamento encontrada para este id externo.', 'FINANCE_BANK_PAYMENT_ROUTING_NOT_FOUND');
  }
  const intent = await getPaymentIntentForUpdate(routing.paymentIntentId, transaction);
  const status = normalizeStatus(externalStatus);
  const beforeJson = intent.toJSON();

  if (intent.status === 'FAILED' && status === 'CONFIRMED') {
    // B4 — confirmação tardia de uma tentativa dada como falha: o dinheiro pode ter saído (e uma
    // nova tentativa também pode ter sido paga). Nunca ignorar em silêncio.
    intent.externalStatus = status;
    await intent.save({ transaction });
    await openAnomaly(
      intent, 'LATE_BANK_CONFIRMATION', 'HIGH',
      `O banco confirmou o pagamento ${externalSubmissionId} depois de ele ter sido dado como falho — verificar pagamento em dobro e reconciliar.`,
      transaction
    );
    await registrarAuditoria(
      { groupId: intent.groupId, companyId: intent.companyId, actorUserId: null, action: 'finance.payment_intent.late_confirmation', entityType: 'PaymentIntent', entityId: intent.id, beforeJson, afterJson: intent.toJSON(), reason: 'Confirmação do banco após falha — caso de anomalia aberto.' },
      transaction
    );
    return intent;
  }
  if (intent.status === 'EXECUTED' && RETURNED_STATUSES.includes(status)) {
    intent.externalStatus = status;
    await intent.save({ transaction });
    await openAnomaly(
      intent, 'BANK_PAYMENT_RETURNED', 'HIGH',
      `O banco informou devolução (${status}) de um pagamento já confirmado (${externalSubmissionId}) — o lançamento continua liquidado; registrar o estorno/recebimento da devolução.`,
      transaction
    );
    return intent;
  }
  if (!['SUBMITTING', 'SUBMITTED'].includes(intent.status)) {
    return intent;
  }

  intent.externalStatus = status;
  if (status === 'CONFIRMED') {
    const entry = await FinancialEntry.findByPk(intent.financialEntryId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
    if (!entry || entry.status !== 'PENDING') {
      // A2 — o lançamento já foi liquidado por outro caminho: o banco pagou de novo.
      intent.status = 'EXECUTED';
      intent.executedAt = new Date();
      intent.uncertainSince = null;
      await intent.save({ transaction });
      await openAnomaly(
        intent, 'DUPLICATE_SETTLEMENT', 'HIGH',
        `O banco confirmou o pagamento ${externalSubmissionId}, mas o lançamento já estava ${entry ? entry.status : 'inexistente'} — possível pagamento em dobro.`,
        transaction
      );
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
    await intent.save({ transaction });
    await registrarAuditoria(
      { groupId: intent.groupId, companyId: intent.companyId, actorUserId: null, action: 'finance.payment_intent.confirm_bank_payment', entityType: 'PaymentIntent', entityId: intent.id, beforeJson, afterJson: intent.toJSON(), reason: `Pagamento confirmado pelo ${options.sandbox ? 'provedor SANDBOX (simulação)' : 'banco'} — lançamento ${settled.id} liquidado.` },
      transaction
    );
  } else if (FINAL_FAILURE_STATUSES.includes(status)) {
    intent.status = 'FAILED';
    intent.failedAt = new Date();
    intent.uncertainSince = null;
    intent.failureReason = `Status retornado pelo banco: ${status}`;
    await intent.save({ transaction });
    await registrarAuditoria(
      { groupId: intent.groupId, companyId: intent.companyId, actorUserId: null, action: 'finance.payment_intent.bank_payment_failed', entityType: 'PaymentIntent', entityId: intent.id, beforeJson, afterJson: intent.toJSON(), reason: `Pagamento recusado/falhou no banco — status "${status}".` },
      transaction
    );
  } else {
    await intent.save({ transaction });
    await registrarAuditoria(
      { groupId: intent.groupId, companyId: intent.companyId, actorUserId: null, action: 'finance.payment_intent.bank_payment_pending', entityType: 'PaymentIntent', entityId: intent.id, beforeJson, afterJson: intent.toJSON(), reason: `Banco respondeu "${status}" (não final) — pagamento continua em trânsito, sem liquidação e sem liberar novo pagamento.` },
      transaction
    );
  }
  return intent;
}

/**
 * reconcilePaymentIntent — B2: consulta o banco para uma intenção incerta.
 *   SUBMITTING sem id externo: reenvia com a MESMA chave de idempotência (o provedor devolve o
 *   pagamento já criado, não cria outro) para obter o id; SUBMITTED: getPaymentStatus.
 */
async function reconcilePaymentIntent(id, actor, transaction) {
  const intent = await getPaymentIntentForUpdate(id, transaction);
  if (!['SUBMITTING', 'SUBMITTED'].includes(intent.status)) return { intent, outcome: 'NOT_UNCERTAIN' };
  const adapter = await resolveBankAdapter({ groupId: intent.groupId, companyId: intent.companyId }, transaction);
  const sandbox = Boolean(adapter.isSandbox);
  intent.reconciliationAttempts = Number(intent.reconciliationAttempts || 0) + 1;
  intent.lastReconciledAt = new Date();
  await intent.save({ transaction });

  if (intent.status === 'SUBMITTING') {
    const result = await callBankSubmit(adapter, buildSubmitRequest(intent));
    const updated = await finalizeBankSubmission(id, result, actor, transaction);
    if (updated.status !== 'SUBMITTED') return { intent: updated, outcome: 'STILL_UNCERTAIN' };
  }
  const current = await PaymentIntent.findByPk(id, { transaction });
  if (!current.externalSubmissionId) return { intent: current, outcome: 'STILL_UNCERTAIN' };
  // M45-RECONF F2: a intenção já sabe o próprio id externo — se o roteamento (usado pelo webhook)
  // não existir (ex.: intenção gravada antes do roteamento, seed de homologação), recria-o aqui
  // em vez de a consulta falhar com 404 e a tela não mostrar nada.
  const routing = await BankPaymentProviderRouting.findOne({ where: { externalSubmissionId: current.externalSubmissionId }, transaction });
  if (!routing) {
    await BankPaymentProviderRouting.create(
      { externalSubmissionId: current.externalSubmissionId, paymentIntentId: current.id, groupId: current.groupId, companyId: current.companyId },
      { transaction }
    );
  } else if (routing.paymentIntentId !== current.id) {
    throw AppError.conflict('O id do banco desta intenção pertence a outra intenção — verifique antes de consultar.', 'FINANCE_BANK_PAYMENT_ROUTING_MISMATCH');
  }
  let statusResult;
  try {
    statusResult = await adapter.getPaymentStatus(current.externalSubmissionId);
  } catch (err) {
    return { intent: current, outcome: 'BANK_UNREACHABLE', error: err.message };
  }
  const confirmed = await confirmBankPayment(current.externalSubmissionId, statusResult.status, transaction, { sandbox });
  return { intent: confirmed, outcome: normalizeStatus(statusResult.status) };
}

/**
 * resolveUncertainPaymentIntent — B2: saída controlada para uma intenção incerta. Consulta o
 * banco primeiro; só marca como falha se o banco responder status final de falha ou não
 * conhecer o pagamento. Se o banco disser que está pago ou em processamento, recusa.
 */
async function resolveUncertainPaymentIntent(id, payload, actor, transaction) {
  const reason = payload && payload.reason ? String(payload.reason).trim() : '';
  if (!reason) {
    throw AppError.badRequest('Informe o motivo para resolver a incerteza do pagamento.', 'FINANCE_PAYMENT_INTENT_RESOLUTION_REASON_REQUIRED');
  }
  const { intent, outcome, error } = await reconcilePaymentIntent(id, actor, transaction);
  if (outcome === 'NOT_UNCERTAIN' || intent.status === 'EXECUTED' || intent.status === 'FAILED') {
    return { intent, outcome };
  }
  if (outcome === 'BANK_UNREACHABLE') {
    throw AppError.conflict(
      `Não foi possível consultar o banco (${error}) — a intenção não pode ser dada como falha sem resposta do banco.`,
      'FINANCE_PAYMENT_INTENT_BANK_UNREACHABLE'
    );
  }
  if (intent.status === 'SUBMITTING' && outcome === 'STILL_UNCERTAIN') {
    throw AppError.conflict(
      'O banco ainda não respondeu sobre este pagamento — não é possível dá-lo como falha.',
      'FINANCE_PAYMENT_INTENT_STILL_UNCERTAIN'
    );
  }
  throw AppError.conflict(
    `O banco informa o pagamento como "${outcome}" (em processamento) — aguarde a resposta final.`,
    'FINANCE_PAYMENT_INTENT_STILL_IN_TRANSIT'
  );
}

module.exports = {
  FINAL_FAILURE_STATUSES,
  RETURNED_STATUSES,
  prepareBankSubmission,
  callBankSubmit,
  finalizeBankSubmission,
  submitPaymentIntentToBank,
  confirmBankPayment,
  reconcilePaymentIntent,
  resolveUncertainPaymentIntent,
};
