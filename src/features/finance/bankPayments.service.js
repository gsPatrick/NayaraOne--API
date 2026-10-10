'use strict';

const { PaymentIntent, BankAccount, BankPaymentProviderRouting } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { resolveBankAdapter } = require('./adapters/resolveBankAdapter');
const { getPaymentIntentForUpdate } = require('./paymentIntents.service');
const { settleFinancialEntry } = require('./financialEntries.service');
const { assertBankAccountEligibleForPayment } = require('./financeAntifraud.service');

// Caminho ADITIVO de submissão bancária real, construído sobre o paymentIntents.service.js já
// existente (M4-07, maker-checker por snapshot+hash). O caminho de liquidação MANUAL
// (executePaymentIntent) continua intocado — este é o caminho novo, usado quando
// `finance.payment_provider` está configurado para um banco real.
//
// Regra do Caderno (PROVIDER_BANCARIO.md §3.2): "Só cria ledger quando houver confirmação
// confiável do banco" / "sistema nunca presume sucesso". Por isso submitPaymentIntentToBank
// NUNCA chama settleFinancialEntry — só confirmBankPayment (chamado por webhook/polling) faz
// isso, e só quando o status reportado pelo adapter é CONFIRMED.

async function submitPaymentIntentToBank(id, paymentMethod, actor, transaction) {
  const intent = await getPaymentIntentForUpdate(id, transaction);
  if (intent.status !== 'APPROVED') {
    throw AppError.conflict(
      `Só é possível submeter ao banco uma intenção APPROVED (atual: "${intent.status}").`,
      'FINANCE_PAYMENT_INTENT_NOT_APPROVED'
    );
  }

  const bankAccountId = intent.snapshotJson?.bankAccountId;
  if (!bankAccountId) {
    throw AppError.badRequest(
      'O lançamento desta intenção não tem conta bancária de destino definida.',
      'FINANCE_BANK_PAYMENT_NO_BANK_ACCOUNT'
    );
  }
  const bankAccount = await BankAccount.findByPk(bankAccountId, { transaction });
  if (!bankAccount) throw AppError.notFound('Conta bancária não encontrada.', 'FINANCE_BANK_ACCOUNT_NOT_FOUND');

  // Reusa a mesma checagem antifraude já usada na liquidação manual (cooldown de conta
  // sensível alterada recentemente — PROVIDER_BANCARIO.md §3.6).
  await assertBankAccountEligibleForPayment(bankAccount.id, transaction);

  // Snapshot do favorecido CONGELADO no momento da submissão — mudar a BankAccount depois
  // nunca afeta este intent já submetido (PROVIDER_BANCARIO.md §3.1).
  // PIX exige chave cadastrada na conta — sem isso o adapter manda a submissão pro banco só
  // pra falhar lá (400/422 do provedor), sem nenhuma validação antecipada do nosso lado.
  if (paymentMethod === 'PIX' && !bankAccount.pixKey) {
    throw AppError.badRequest(
      'A conta bancária de destino não tem chave PIX cadastrada.',
      'FINANCE_BANK_PAYMENT_MISSING_PIX_KEY'
    );
  }

  const beneficiarySnapshot = {
    personId: bankAccount.ownerPersonId || null,
    name: intent.snapshotJson?.description || null,
    bankCode: bankAccount.bankCode || null,
    branch: bankAccount.agency || null,
    account: bankAccount.accountNumber || null,
    pixKey: bankAccount.pixKey || null,
  };

  const idempotencyKey = `payment-intent:${intent.id}`;
  const adapter = await resolveBankAdapter({ groupId: intent.groupId, companyId: intent.companyId }, transaction);

  const submission = await adapter.submitPayment({
    paymentMethod,
    idempotencyKey,
    amount: intent.snapshotJson?.amount,
    providerPayload: { amount: intent.snapshotJson?.amount, beneficiary: beneficiarySnapshot },
  });

  const beforeJson = intent.toJSON();
  intent.bankAccountId = bankAccountId;
  intent.beneficiarySnapshot = beneficiarySnapshot;
  intent.paymentMethod = paymentMethod;
  intent.idempotencyKey = idempotencyKey;
  intent.externalSubmissionId = submission.externalId;
  intent.externalStatus = submission.status;
  intent.status = 'SUBMITTED';
  intent.submittedAt = new Date();
  intent.updatedBy = actor.userId || null;
  await intent.save({ transaction });

  // Mesmo padrão de SignatureProviderRouting: linha de roteamento gravada na MESMA transação,
  // pra o webhook público do banco (sem JWT/tenant conhecido) conseguir resolver o tenant.
  await BankPaymentProviderRouting.create(
    {
      externalSubmissionId: submission.externalId,
      paymentIntentId: intent.id,
      groupId: intent.groupId,
      companyId: intent.companyId,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: intent.groupId,
      companyId: intent.companyId,
      actorUserId: actor.userId,
      action: 'finance.payment_intent.submit_to_bank',
      entityType: 'PaymentIntent',
      entityId: intent.id,
      beforeJson,
      afterJson: intent.toJSON(),
      reason: `Pagamento submetido ao banco via ${paymentMethod} — id externo ${submission.externalId}.`,
    },
    transaction
  );

  return intent;
}

// Chamado por webhook do provedor OU por job de polling (ambos devem ser idempotentes —
// PROVIDER_BANCARIO.md §3.3). `externalStatus` é o valor cru retornado pelo adapter;
// 'CONFIRMED' é o único que libera a liquidação real do lançamento.
async function confirmBankPayment(externalSubmissionId, externalStatus, transaction) {
  const routing = await BankPaymentProviderRouting.findOne({ where: { externalSubmissionId }, transaction });
  if (!routing) {
    throw AppError.notFound('Nenhuma intenção de pagamento encontrada para este id externo.', 'FINANCE_BANK_PAYMENT_ROUTING_NOT_FOUND');
  }

  const intent = await getPaymentIntentForUpdate(routing.paymentIntentId, transaction);

  // Idempotência: reprocessar o mesmo status num intent que já saiu de SUBMITTED não duplica
  // efeito nenhum — simplesmente retorna o estado atual.
  if (!['SUBMITTED'].includes(intent.status)) {
    return intent;
  }

  const beforeJson = intent.toJSON();
  intent.externalStatus = externalStatus;

  if (externalStatus === 'CONFIRMED') {
    const settled = await settleFinancialEntry(intent.financialEntryId, null, transaction);
    intent.status = 'EXECUTED';
    intent.executedAt = new Date();
    await intent.save({ transaction });

    await registrarAuditoria(
      {
        groupId: intent.groupId,
        companyId: intent.companyId,
        actorUserId: null,
        action: 'finance.payment_intent.confirm_bank_payment',
        entityType: 'PaymentIntent',
        entityId: intent.id,
        beforeJson,
        afterJson: intent.toJSON(),
        reason: `Pagamento confirmado pelo banco — lançamento ${settled.id} liquidado.`,
      },
      transaction
    );
  } else {
    // Falha externa NÃO reverte nada já confirmado (não há nada confirmado ainda nesse ponto,
    // já que ledger só é escrito em CONFIRMED) — só marca FAILED pra reprocessamento/revisão
    // humana, nunca "desfaz" silenciosamente.
    intent.status = 'FAILED';
    intent.failedAt = new Date();
    intent.failureReason = `Status retornado pelo banco: ${externalStatus}`;
    await intent.save({ transaction });

    await registrarAuditoria(
      {
        groupId: intent.groupId,
        companyId: intent.companyId,
        actorUserId: null,
        action: 'finance.payment_intent.bank_payment_failed',
        entityType: 'PaymentIntent',
        entityId: intent.id,
        beforeJson,
        afterJson: intent.toJSON(),
        reason: `Pagamento recusado/falhou no banco — status "${externalStatus}".`,
      },
      transaction
    );
  }

  return intent;
}

module.exports = { submitPaymentIntentToBank, confirmBankPayment };
