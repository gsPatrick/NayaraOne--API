'use strict';

/**
 * PREPARE do pagamento (Guia M4 §4 preparePayment; Caderno §8 passos 1 a 5):
 *   1. lançamento OPEN/PARTIAL (PENDING ou PARTIALLY_SETTLED) travado (FOR UPDATE), na empresa do contexto (RLS);
 *   2. assertPayable — só lançamento a PAGAR (PAYABLE/DEBIT): intenção de pagamento sobre recebível é recusada (sonda V2-P3);
 *   3. assertAmountWithinOpenBalance — o usuário escolhe o valor (parcela) até o saldo em aberto; sem valor, paga o saldo;
 *   4. retrato aprovável (lançamento + valor/parcela + favorecido congelado) e o hash dele + idempotency_key;
 *   5. REG-FIN-002 (Motor de Regras) ou faixas da DEC-004 decidem risco e nº de aprovadores, e o pedido de aprovação nasce da regra
 *      (approvals.createFromRule), com o mesmo retrato e hash. A intenção passa de DRAFT a PENDING_APPROVAL na mesma transação.
 */
const crypto = require('node:crypto');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const intents = require('../../infrastructure/repositories/payment-intent.repository');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const ledger = require('../../infrastructure/repositories/ledger-movement.repository');
const domain = require('../../domain/payment-intent');
const { OPEN_FOR_SETTLEMENT_STATUSES } = require('../../domain/financial-entry');
const { publishPaymentPrepared } = require('./finance-events.service');
const { getApprovalRequest } = require('./approvals.service');
const { computeRemainingAmount } = require('./ledger-balance.service');
const { resolvePaymentApprovalPolicy } = require('./payment-approval-policy');
const { loadBeneficiary } = require('./payment-snapshot');
const workflow = require('./approval-workflow');

function audit(intent, actorUserId, action, beforeJson, reason, transaction) {
  return registrarAuditoria(
    { groupId: intent.groupId, companyId: intent.companyId, actorUserId, action, entityType: 'PaymentIntent', entityId: intent.id, beforeJson, afterJson: intent.toJSON(), reason },
    transaction
  );
}

/** Valor escolhido no PREPARE em centavos (sem valor = o saldo em aberto). */
function chosenAmountCents(rawAmount, remainingCents) {
  if (rawAmount === undefined || rawAmount === null || rawAmount === '') return remainingCents;
  const cents = domain.toCents(String(rawAmount));
  if (cents === null || cents <= 0) {
    throw AppError.badRequest('Informe o valor a pagar (maior que zero, até 2 casas decimais).', 'FINANCE_PAYMENT_INTENT_VALIDATION');
  }
  if (cents > remainingCents) {
    throw AppError.conflict(
      `O valor escolhido (R$ ${domain.centsText(cents)}) passa do saldo em aberto do lançamento (R$ ${domain.centsText(remainingCents)}).`,
      'FINANCE_PAYMENT_INTENT_AMOUNT_EXCEEDS_BALANCE',
      { amount: domain.centsText(cents), openBalance: domain.centsText(remainingCents) }
    );
  }
  return cents;
}

async function createPaymentIntent(payload, actorUserId, transaction) {
  const { financialEntryId, approvalRequestId } = payload;
  if (!financialEntryId) {
    throw AppError.badRequest('Escolha o lançamento para criar a intenção de pagamento.', 'FINANCE_PAYMENT_INTENT_VALIDATION');
  }
  // B3 (revisão independente): o lock serializa duas criações simultâneas; o índice único parcial payment_intents_one_open_per_entry
  // é a garantia final.
  const entry = await entries.findByIdForUpdate(financialEntryId, transaction);
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  if (!domain.isPayable(entry)) {
    throw AppError.conflict(
      `Intenção de pagamento só vale para lançamento a pagar (este é ${entry.nature === 'RECEIVABLE' ? 'a receber' : entry.nature}): dinheiro não sai para quem deve à empresa.`,
      'FINANCE_PAYMENT_INTENT_NOT_PAYABLE'
    );
  }
  if (!OPEN_FOR_SETTLEMENT_STATUSES.includes(entry.status)) {
    throw AppError.conflict(
      `Só é possível preparar pagamento de um lançamento em aberto ou parcialmente pago (atual: "${entry.status}").`,
      'FINANCE_PAYMENT_INTENT_INVALID_ENTRY_STATUS'
    );
  }
  // §17: pagamento ainda não avaliado pelo antifraude é avaliado aqui (fica retido até a revisão humana).
  await require('./payment-anomaly-gate').evaluateAndAssertPreparable(entry, transaction, actorUserId); // DEC-007: achado bloqueante não vira intenção

  const existing = await intents.findOneForEntry(financialEntryId, domain.OPEN_STATUSES, transaction);
  if (existing) {
    throw AppError.conflict('Já existe uma intenção de pagamento em aberto para este lançamento.', 'FINANCE_PAYMENT_INTENT_ALREADY_OPEN', { existingId: existing.id });
  }
  if (approvalRequestId) {
    // F06-PAY-02: a aprovação de OUTRO lançamento nunca é reaproveitada. A aprovação da intenção nasce da regra, logo abaixo.
    const informed = await getApprovalRequest(approvalRequestId, transaction);
    if (informed.relatedEntityId !== entry.id) {
      throw AppError.badRequest('A solicitação de aprovação informada não se refere a este lançamento.', 'FINANCE_PAYMENT_INTENT_VALIDATION');
    }
  }

  const remainingCents = domain.toCents(await computeRemainingAmount(entry, transaction));
  const amountCents = chosenAmountCents(payload.amount, remainingCents);
  const installmentNumber = (await ledger.countSettledChildren(entry.id, transaction)) + 1;
  const beneficiary = await loadBeneficiary(entry.bankAccountId, entry.description, transaction);
  const snapshot = domain.buildApprovableSnapshot(entry, { amountCents, installmentNumber, beneficiary });
  const tenant = { groupId: entry.groupId, companyId: entry.companyId };
  const policy = await resolvePaymentApprovalPolicy(entry, amountCents, tenant, transaction);

  let intent;
  try {
    const intentId = crypto.randomUUID();
    intent = await intents.create(
      {
        id: intentId,
        idempotencyKey: domain.idempotencyKeyFor(intentId),
        groupId: entry.groupId,
        companyId: entry.companyId,
        financialEntryId: entry.id,
        bankAccountId: entry.bankAccountId || null,
        beneficiarySnapshot: beneficiary,
        amount: snapshot.amount,
        installmentNumber,
        snapshotJson: snapshot,
        snapshotHash: domain.computeSnapshotHash(snapshot),
        status: 'DRAFT',
        submissionPhase: 'NOT_STARTED',
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
    `Intenção de pagamento preparada para o lançamento ${entry.id}: R$ ${snapshot.amount} (parcela ${installmentNumber}), favorecido congelado ` +
      `(${beneficiary.bankCode || '-'}/${beneficiary.branch || '-'}/${beneficiary.account || '-'}${beneficiary.pixKey ? ', PIX' : ''}) — retrato ${intent.snapshotHash.slice(0, 12)}.`, transaction);
  await publishPaymentPrepared(intent, transaction);

  const approval = await workflow.createApprovalFor(
    {
      groupId: intent.groupId,
      companyId: intent.companyId,
      relatedEntityType: 'PaymentIntent',
      relatedEntityId: intent.id,
      riskLevel: policy.riskLevel,
      requiredApprovals: policy.requiredApprovals,
      ruleVersionId: policy.ruleVersionId,
      riskSource: policy.riskSource,
      snapshot,
      amount: snapshot.amount,
    },
    actorUserId,
    transaction
  );
  const beforeJson = intent.toJSON();
  intent.approvalRequestId = approval.id;
  intent.status = 'PENDING_APPROVAL';
  await intents.save(intent, transaction);
  await audit(intent, actorUserId, 'finance.payment_intent.pending_approval', beforeJson,
    `Aprovação conforme a regra: risco ${policy.riskLevel} (${policy.riskSource === 'RULE' ? 'REG-FIN-002' : 'faixas de valor'}), ${policy.requiredApprovals} aprovação(ões)` +
      `${policy.mfaRequired ? ' com MFA recente' : ''}.`, transaction);
  intent.dataValues.approval = { id: approval.id, riskLevel: approval.riskLevel, requiredApprovals: approval.requiredApprovals, approvedCount: 0, riskSource: approval.riskSource };
  return intent;
}

module.exports = { createPaymentIntent, chosenAmountCents };
