'use strict';

/**
 * Envio do pagamento ao banco (PROVIDER_BANCARIO.md §3.2; Guia M4 §4 e §6), parte do pagamento cuja confirmação
 * está em payment.service.js#confirmBankPayment.
 *
 * REVISÃO INDEPENDENTE (conferência Nayara 18/10/2026):
 *   B1 — a chamada externa acontecia dentro da transação: se o commit falhasse depois que o banco aceitou, o
 *        pagamento existia no banco sem registro local. Agora a submissão tem 3 fases (prepareBankSubmission grava
 *        SUBMITTING e COMMITA; a chamada ao banco roda fora de transação levando a chave de idempotência;
 *        finalizeBankSubmission grava o resultado). Erro/timeout deixa a intenção SUBMITTING (incerta).
 *   B2 — reconcilePaymentIntent (job e ação manual) consulta o banco para intenções incertas;
 *        resolveUncertainPaymentIntent é a saída controlada (motivo + auditoria).
 * M9-D237: o envio passa pelo Dispatch Service (bank-hub): HTTP 200/202 só envia (SUBMITTED), o status final
 * assinado ou consultado confirma, e o valor confere em centavos.
 */
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const intents = require('../../infrastructure/repositories/payment-intent.repository');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const { canSubmitToBank, currentEntryHash, isInFlight, normalizeStatus, idempotencyKeyFor } = require('../../domain/payment-intent');
const bank = require('./bank-hub');
const { assertBankProviderReady } = require('../../infrastructure/bank/hub/bank.ready');
const { resolveUncertainSubmission, queryPaymentStatus } = require('../../infrastructure/bank/hub/bank.uncertain');
const { getPaymentIntentForUpdate, confirmBankPayment } = require('./payment.service');
const { assertBankAccountEligibleForPayment } = require('./finance-antifraud.service');

function audit(intent, actorUserId, action, beforeJson, reason, transaction) {
  return registrarAuditoria(
    { groupId: intent.groupId, companyId: intent.companyId, actorUserId, action, entityType: 'PaymentIntent', entityId: intent.id, beforeJson, afterJson: intent.toJSON(), reason },
    transaction
  );
}

/** Fase 1 — valida e grava SUBMITTING (o chamador deve COMMITAR antes de chamar o banco). */
async function prepareBankSubmission(id, paymentMethod, actor, transaction) {
  const intent = await getPaymentIntentForUpdate(id, transaction);
  if (!canSubmitToBank(intent)) {
    throw AppError.conflict(`Só é possível submeter ao banco uma intenção APPROVED (atual: "${intent.status}").`, 'FINANCE_PAYMENT_INTENT_NOT_APPROVED');
  }
  // R5: o envio ao banco só vale se o lançamento continua igual ao retrato aprovado.
  const currentEntry = await entries.findById(intent.financialEntryId, transaction);
  if (!currentEntry || currentEntryHash(currentEntry) !== intent.snapshotHash) {
    throw AppError.conflict(
      'O lançamento foi alterado depois da aprovação desta intenção: o envio ao banco foi recusado. Crie uma nova intenção sobre a versão atual.',
      'FINANCE_PAYMENT_INTENT_STALE'
    );
  }
  if (currentEntry.requiresManualReview) {
    throw AppError.conflict('Este pagamento está retido para revisão manual (antifraude): ele só vai ao banco depois de liberado por um revisor.', 'FINANCE_ENTRY_REQUIRES_MANUAL_REVIEW');
  }
  const bankAccountId = intent.snapshotJson?.bankAccountId;
  if (!bankAccountId) {
    throw AppError.badRequest('O lançamento desta intenção não tem conta bancária de destino definida.', 'FINANCE_BANK_PAYMENT_NO_BANK_ACCOUNT');
  }
  const bankAccount = await intents.findBankAccount(bankAccountId, transaction);
  if (!bankAccount) throw AppError.notFound('Conta bancária não encontrada.', 'FINANCE_BANK_ACCOUNT_NOT_FOUND');
  await assertBankAccountEligibleForPayment(bankAccount.id, transaction);
  if (paymentMethod === 'PIX' && !bankAccount.pixKey) {
    throw AppError.badRequest('A conta bancária de destino não tem chave PIX cadastrada.', 'FINANCE_BANK_PAYMENT_MISSING_PIX_KEY');
  }
  // Confere o provedor já aqui: configuração incompleta falha ANTES de qualquer estado mudar.
  await assertBankProviderReady({ groupId: intent.groupId, companyId: intent.companyId, userId: actor.userId || null }, transaction);

  const ownerPerson = bankAccount.ownerPersonId ? await entries.findPerson(bankAccount.ownerPersonId, transaction) : null;
  const beneficiarySnapshot = {
    personId: bankAccount.ownerPersonId || null,
    name: ownerPerson?.legalName || intent.snapshotJson?.description || null,
    bankCode: bankAccount.bankCode || null,
    branch: bankAccount.agency || null,
    account: bankAccount.accountNumber || null,
    pixKey: bankAccount.pixKey || null,
  };
  const beforeJson = intent.toJSON();
  intent.bankAccountId = bankAccountId;
  intent.beneficiarySnapshot = beneficiarySnapshot;
  intent.paymentMethod = paymentMethod;
  intent.idempotencyKey = intent.idempotencyKey || idempotencyKeyFor(intent.id); // §8.4: intenção antiga sem chave recebe o mesmo formato
  intent.status = 'SUBMITTING';
  intent.uncertainSince = new Date();
  intent.updatedBy = actor.userId || null;
  await intents.save(intent, transaction);
  await audit(intent, actor.userId, 'finance.payment_intent.submitting', beforeJson,
    `Envio ao banco iniciado via ${paymentMethod} — chave de idempotência ${intent.idempotencyKey}.`, transaction);
  return { intent, request: bank.buildSubmitRequest(intent) };
}

/**
 * Fase 2 — a ordem ao banco pelo Dispatch Service, FORA de transação (ou, com `transaction`, nela). Nunca lança: devolve { ok, externalId, status } | { deferred } | { ok:false, error }.
 * @param {any} prepared
 * @param {{ transaction?: any }} [options]
 */
async function callBankSubmit(prepared, { transaction } = {}) {
  const result = await bank.callBankSubmit({ intent: prepared.intent, transaction });
  if (result.ok && !result.externalId) return { ok: false, error: 'Resposta do banco sem identificador do pagamento.' };
  return result;
}

async function ensureRouting(externalSubmissionId, intent, transaction) {
  const existingRouting = await intents.findRouting(externalSubmissionId, transaction);
  if (!existingRouting) {
    await intents.createRouting({ externalSubmissionId, paymentIntentId: intent.id, groupId: intent.groupId, companyId: intent.companyId }, transaction);
  }
  return existingRouting;
}

/** Fase 3 — grava o resultado da chamada. */
async function finalizeBankSubmission(id, result, actor, transaction) {
  const intent = await getPaymentIntentForUpdate(id, transaction);
  if (intent.status !== 'SUBMITTING') return intent;
  const beforeJson = intent.toJSON();
  if (!result.ok) {
    intent.externalStatus = result.deferred ? 'QUEUED' : 'UNCERTAIN';
    intent.failureReason = result.deferred
      ? `Ordem reagendada: ${result.error} Nada foi enviado ao banco; o worker de envios repete sem duplicar (mesma chave de idempotência).`
      : `Resposta do banco incerta: ${result.error}. A intenção fica em envio incerto até a reconciliação consultar o banco.`;
    intent.updatedBy = actor.userId || null;
    await intents.save(intent, transaction);
    await audit(intent, actor.userId, result.deferred ? 'finance.payment_intent.submission_deferred' : 'finance.payment_intent.submission_uncertain', beforeJson, intent.failureReason, transaction);
    return intent;
  }
  intent.externalSubmissionId = result.externalId;
  intent.externalStatus = result.status || null;
  intent.status = 'SUBMITTED';
  intent.submittedAt = new Date();
  intent.failureReason = null;
  intent.updatedBy = actor.userId || null;
  await intents.save(intent, transaction);
  await ensureRouting(result.externalId, intent, transaction);
  await audit(intent, actor.userId, 'finance.payment_intent.submit_to_bank', beforeJson,
    `Pagamento submetido ao banco via ${intent.paymentMethod} — id externo ${result.externalId}.`, transaction);
  return intent;
}

/**
 * submitPaymentIntentToBank — as 3 fases numa única transação. Usado por chamadores que já estão dentro de uma
 * transação (testes de serviço). A rota HTTP usa as 3 fases em transações separadas (finance.controller.js), que
 * é o caminho seguro contra queda entre banco e commit.
 */
async function submitPaymentIntentToBank(id, paymentMethod, actor, transaction) {
  const prepared = await prepareBankSubmission(id, paymentMethod, actor, transaction);
  const result = await callBankSubmit(prepared, { transaction });
  return finalizeBankSubmission(id, result, actor, transaction);
}

/**
 * reconcilePaymentIntent — B2: consulta o banco para uma intenção incerta.
 *   SUBMITTING sem id externo: reenvia com a MESMA chave de idempotência (o provedor devolve o
 *   pagamento já criado, não cria outro) para obter o id; SUBMITTED: getPaymentStatus.
 */
async function reconcilePaymentIntent(id, actor, transaction) {
  const intent = await getPaymentIntentForUpdate(id, transaction);
  if (!isInFlight(intent)) return { intent, outcome: 'NOT_UNCERTAIN' };
  intent.reconciliationAttempts = Number(intent.reconciliationAttempts || 0) + 1;
  intent.lastReconciledAt = new Date();
  await intents.save(intent, transaction);

  if (intent.status === 'SUBMITTING') {
    const result = await resolveUncertainSubmission(intent, transaction);
    const updated = await finalizeBankSubmission(id, result, actor, transaction);
    if (updated.status !== 'SUBMITTED') return { intent: updated, outcome: 'STILL_UNCERTAIN' };
  }
  const current = await intents.findById(id, transaction);
  if (!current.externalSubmissionId) return { intent: current, outcome: 'STILL_UNCERTAIN' };
  // M45-RECONF F2: a intenção já sabe o próprio id externo — se o roteamento (usado pelo webhook)
  // não existir (ex.: intenção gravada antes do roteamento, seed de homologação), recria-o aqui
  // em vez de a consulta falhar com 404 e a tela não mostrar nada.
  const routing = await ensureRouting(current.externalSubmissionId, current, transaction);
  if (routing && routing.paymentIntentId !== current.id) {
    throw AppError.conflict('O id do banco desta intenção pertence a outra intenção — verifique antes de consultar.', 'FINANCE_BANK_PAYMENT_ROUTING_MISMATCH');
  }
  let statusResult;
  try {
    statusResult = await queryPaymentStatus(current, transaction);
  } catch (/** @type {any} */ err) {
    return { intent: current, outcome: 'BANK_UNREACHABLE', error: err.message };
  }
  const confirmed = await confirmBankPayment(current.externalSubmissionId, statusResult.status, transaction, { sandbox: statusResult.sandbox, amount: statusResult.amount, source: 'STATUS_QUERY' });
  if (confirmed.bankMismatch) return { intent: confirmed, outcome: 'AMOUNT_MISMATCH', code: bank.MISMATCH_CODE };
  return { intent: confirmed, outcome: bank.isPaidStatus(statusResult.status) ? 'CONFIRMED' : normalizeStatus(statusResult.status) };
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
    throw AppError.conflict('O banco ainda não respondeu sobre este pagamento — não é possível dá-lo como falha.', 'FINANCE_PAYMENT_INTENT_STILL_UNCERTAIN');
  }
  throw AppError.conflict(
    `O banco informa o pagamento como "${outcome}" (em processamento) — aguarde a resposta final.`,
    'FINANCE_PAYMENT_INTENT_STILL_IN_TRANSIT'
  );
}

module.exports = {
  prepareBankSubmission,
  callBankSubmit,
  finalizeBankSubmission,
  submitPaymentIntentToBank,
  reconcilePaymentIntent,
  resolveUncertainPaymentIntent,
};
