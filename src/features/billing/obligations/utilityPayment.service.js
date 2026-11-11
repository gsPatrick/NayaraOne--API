'use strict';

const { formatMoneyBR } = require('../../../utils/formatBR');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { createFinancialEntry } = require('../../../modules/finance/application/services/financial-entry.service');
const { getOrCreateDefaultResultCenter } = require('../../../modules/finance/application/services/result-centers.service');
const { UtilityReimbursement } = require('../../../models');
const { publishReimbursementCreated } = require('../billingEvents.service');
const cycles = require('./obligationCycles.service');

// Separado de utilities.service.js (fechamento M5): o pagamento de um vencimento da obrigação, com comprovante e reembolso.
const UTILITIES_RESULT_CENTER_CODE = 'LOCACAO-UTILIDADES';
const UTILITY_TYPE_LABELS = { WATER: 'água', ELECTRICITY: 'energia elétrica', GAS: 'gás', CONDO: 'condomínio', IPTU: 'IPTU', SPU: 'SPU (laudêmio/foro)', OTHER: 'outra despesa' };
const PARTY_LABELS = { LANDLORD: 'o locador', TENANT: 'o locatário' };

async function getUtilityObligation(id, transaction) {
  return require('../utilities.service').getUtilityObligation(id, transaction);
}

/**
 * recordUtilityPayment — a imobiliária paga uma conta de utilidade. Se `paidByParty` for
 * DIFERENTE do `responsibleParty` da obrigação, gera AUTOMATICAMENTE um
 * UtilityReimbursement (a receber da parte responsável) + FinancialEntry RECEIVABLE real —
 * nunca fica só um registro informativo sem lançamento contábil correspondente.
 */
async function recordUtilityPayment(utilityObligationId, payload, actorUserId, transaction) {
  const obligation = await getUtilityObligation(utilityObligationId, transaction);
  const { amount, paidByParty } = payload;
  if (amount === undefined || amount === null || !paidByParty) {
    throw AppError.badRequest('Os campos "amount" e "paidByParty" são obrigatórios.', 'UTILITY_PAYMENT_VALIDATION');
  }
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw AppError.badRequest('"amount" deve ser um número positivo.', 'UTILITY_PAYMENT_VALIDATION');
  }
  if (typeof paidByParty !== 'string' || !/^[A-Za-z_]{2,16}$/.test(paidByParty)) {
    throw AppError.badRequest('"paidByParty" deve ser quem pagou (ex.: COMPANY, TENANT, LANDLORD), até 16 letras.', 'UTILITY_PAYMENT_VALIDATION');
  }
  if (typeof amount === 'object') throw AppError.badRequest('"amount" deve ser um número positivo.', 'UTILITY_PAYMENT_VALIDATION');
  const normalizedPaidBy = String(paidByParty).toUpperCase();
  // Fechamento M5 (livro §12 "periodicidade, comprovante e status"; M5-A0346): o pagamento é de UM vencimento (ciclo), com
  // comprovante. O ciclo é a chave natural: pagar de novo o mesmo vencimento é recusado (409), com ou sem Idempotency-Key.
  const cycle = await cycles.resolvePaymentCycle(obligation, payload, transaction);
  const proofFileId = await cycles.assertProofFile(payload.proofFileId, obligation, transaction);

  if (normalizedPaidBy === obligation.responsibleParty) {
    // A parte certa pagou — nada a reembolsar; o vencimento fica pago com o comprovante.
    await cycles.markCyclePaid(cycle, { proofFileId, amount: numericAmount, paidByParty: normalizedPaidBy }, actorUserId, transaction);
    await registrarAuditoria(
      {
        groupId: obligation.groupId,
        companyId: obligation.companyId,
        actorUserId,
        action: 'billing.utility_payment.record',
        entityType: 'UtilityObligation',
        entityId: obligation.id,
        beforeJson: { ...obligation.toJSON(), pagamentoRegistrado: false },
        afterJson: { ...obligation.toJSON(), pagamentoRegistrado: true, amount: numericAmount, paidByParty: normalizedPaidBy, vencimento: cycle.dueOn, reembolso: 'não se aplica (pago pela parte responsável)' },
        reason: `Pagamento de utilidade de ${formatMoneyBR(numericAmount)} registrado — pago pela parte responsável ("${normalizedPaidBy}"), sem reembolso.`,
      },
      transaction
    );
    return { reimbursement: null, financialEntry: null, cycle };
  }

  const owedByParty = obligation.responsibleParty;

  const resultCenter = await getOrCreateDefaultResultCenter(
    obligation.groupId,
    obligation.companyId,
    UTILITIES_RESULT_CENTER_CODE,
    'Locação — reembolso de utilidades',
    transaction
  );
  const financialEntry = await createFinancialEntry(
    {
      groupId: obligation.groupId,
      companyId: obligation.companyId,
      contractId: obligation.contractId,
      entryType: 'CREDIT',
      nature: 'RECEIVABLE',
      amount: numericAmount,
      description: `Reembolso de ${UTILITY_TYPE_LABELS[obligation.utilityType] || 'despesa do imóvel'} pago por ${PARTY_LABELS[normalizedPaidBy] || 'uma das partes'}, a cobrar de ${PARTY_LABELS[owedByParty] || 'outra parte'}.`,
      dueAt: new Date(),
      idempotencyKey: `utility_reimbursement:${obligation.id}:${cycle.id}`, // chave natural: um reembolso por vencimento
      resultCenterId: resultCenter.id,
    },
    actorUserId,
    transaction
  );

  const reimbursement = await UtilityReimbursement.create(
    {
      groupId: obligation.groupId,
      companyId: obligation.companyId,
      utilityObligationId: obligation.id,
      paidByParty: normalizedPaidBy,
      owedByParty,
      amount: numericAmount,
      financialEntryId: financialEntry.id,
      status: 'PENDING',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishReimbursementCreated(reimbursement, transaction);
  await cycles.markCyclePaid(cycle, { proofFileId, amount: numericAmount, paidByParty: normalizedPaidBy, reimbursementId: reimbursement.id }, actorUserId, transaction);

  await registrarAuditoria(
    {
      groupId: obligation.groupId,
      companyId: obligation.companyId,
      actorUserId,
      action: 'billing.utility_reimbursement.create',
      entityType: 'UtilityReimbursement',
      entityId: reimbursement.id,
      afterJson: reimbursement.toJSON(),
      reason: `Reembolso de ${formatMoneyBR(numericAmount)} criado: pago por "${normalizedPaidBy}", a cobrar de "${owedByParty}".`,
    },
    transaction
  );

  return { reimbursement, financialEntry, cycle };
}

module.exports = { recordUtilityPayment };
