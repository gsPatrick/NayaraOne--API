'use strict';

const { GuaranteedRentContract, Contract } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { createFinancialEntry } = require('../finance/financialEntries.service');
const { publishGuaranteedRentPaid } = require('./billingEvents.service');

/**
 * enrollGuaranteedRent — matricula um contrato de locação no produto de aluguel garantido.
 * PRODUTO SEPARADO de rent_advances (antecipação) — tabela própria, nunca reaproveitada.
 */
async function enrollGuaranteedRent(payload, actorUserId, transaction) {
  const { groupId, companyId, contractId, coverageStartsAt } = payload;
  if (!groupId || !companyId || !contractId || !coverageStartsAt) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "contractId" e "coverageStartsAt" são obrigatórios.',
      'GUARANTEED_RENT_VALIDATION'
    );
  }
  const contract = await Contract.findByPk(contractId, { transaction });
  if (!contract) throw AppError.notFound('Contrato não encontrado.', 'GUARANTEED_RENT_CONTRACT_NOT_FOUND');

  const existing = await GuaranteedRentContract.findOne({ where: { contractId }, transaction });
  if (existing) {
    throw AppError.conflict('Este contrato já está matriculado em aluguel garantido.', 'GUARANTEED_RENT_DUPLICATE');
  }

  const guaranteedRentContract = await GuaranteedRentContract.create(
    {
      groupId,
      companyId,
      contractId,
      status: 'ACTIVE',
      coverageStartsAt,
      coverageEndsAt: payload.coverageEndsAt || null,
      paymentsJson: [],
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'billing.guaranteed_rent.enroll',
      entityType: 'GuaranteedRentContract',
      entityId: guaranteedRentContract.id,
      afterJson: guaranteedRentContract.toJSON(),
      reason: `Contrato ${contractId} matriculado em aluguel garantido.`,
    },
    transaction
  );

  return guaranteedRentContract;
}

async function getGuaranteedRentContract(id, transaction, options = {}) {
  const item = await GuaranteedRentContract.findByPk(id, { transaction, lock: options.lock });
  if (!item) throw AppError.notFound('Aluguel garantido não encontrado.', 'GUARANTEED_RENT_NOT_FOUND');
  return item;
}

async function listGuaranteedRentContracts(transaction, filters = {}) {
  const where = {};
  if (filters.contractId) where.contractId = filters.contractId;
  return GuaranteedRentContract.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

/**
 * payGuaranteedRent — a imobiliária paga o proprietário do valor do aluguel referente a uma
 * competência, independentemente de o locatário ter pago ou não, e simultaneamente registra o
 * crédito a recuperar do locatário. Gera DOIS FinancialEntry REAIS (nunca um lançamento
 * "sintético" fora do ledger):
 *   1. PAYABLE — obrigação própria da imobiliária de pagar o proprietário.
 *   2. RECEIVABLE — crédito a recuperar do locatário.
 */
async function payGuaranteedRent(guaranteedRentContractId, payload, actorUserId, transaction) {
  // FIX (concorrência): a checagem de duplicidade de competência (paymentsJson.some(period))
  // era um SELECT-then-UPDATE sem lock — duas chamadas concorrentes de payGuaranteedRent para a
  // MESMA competência liam o mesmo `paymentsJson` (sem a entrada ainda) e as duas passavam. A
  // unicidade de idempotency_key (`guaranteed_rent.payable:<id>:<period>`) até impede o
  // FinancialEntry duplicado no banco, mas a segunda chamada estourava como erro cru de
  // constraint em vez do erro de negócio GUARANTEED_RENT_PAYMENT_DUPLICATE. `lock:
  // transaction.LOCK.UPDATE` serializa as duas tentativas: a segunda só lê depois que a
  // primeira commitar, e aí encontra a competência já paga e é rejeitada corretamente.
  const guaranteedRentContract = await getGuaranteedRentContract(guaranteedRentContractId, transaction, {
    lock: transaction.LOCK.UPDATE,
  });
  if (guaranteedRentContract.status !== 'ACTIVE') {
    throw AppError.conflict('Aluguel garantido não está ativo.', 'GUARANTEED_RENT_INACTIVE');
  }
  const { period, amount } = payload;
  if (!period || amount === undefined || amount === null) {
    throw AppError.badRequest('Os campos "period" e "amount" são obrigatórios.', 'GUARANTEED_RENT_PAYMENT_VALIDATION');
  }
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw AppError.badRequest('"amount" deve ser um número positivo.', 'GUARANTEED_RENT_PAYMENT_VALIDATION');
  }

  const previousPayments = Array.isArray(guaranteedRentContract.paymentsJson) ? guaranteedRentContract.paymentsJson : [];
  if (previousPayments.some((p) => p.period === period)) {
    throw AppError.conflict(`Já existe pagamento de aluguel garantido registrado para a competência "${period}".`, 'GUARANTEED_RENT_PAYMENT_DUPLICATE');
  }

  const beforeJson = guaranteedRentContract.toJSON();

  const payableEntry = await createFinancialEntry(
    {
      groupId: guaranteedRentContract.groupId,
      companyId: guaranteedRentContract.companyId,
      contractId: guaranteedRentContract.contractId,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: numericAmount,
      description: `Aluguel garantido — pagamento ao proprietário, competência ${period}.`,
      dueAt: new Date(),
      idempotencyKey: `guaranteed_rent.payable:${guaranteedRentContract.id}:${period}`,
    },
    actorUserId,
    transaction
  );

  const receivableEntry = await createFinancialEntry(
    {
      groupId: guaranteedRentContract.groupId,
      companyId: guaranteedRentContract.companyId,
      contractId: guaranteedRentContract.contractId,
      entryType: 'CREDIT',
      nature: 'RECEIVABLE',
      amount: numericAmount,
      description: `Aluguel garantido — crédito a recuperar do locatário, competência ${period}.`,
      dueAt: new Date(),
      idempotencyKey: `guaranteed_rent.receivable:${guaranteedRentContract.id}:${period}`,
    },
    actorUserId,
    transaction
  );

  guaranteedRentContract.paymentsJson = [
    ...previousPayments,
    {
      period,
      amount: numericAmount,
      payableEntryId: payableEntry.id,
      receivableEntryId: receivableEntry.id,
      paidAt: new Date().toISOString(),
    },
  ];
  guaranteedRentContract.updatedBy = actorUserId || null;
  await guaranteedRentContract.save({ transaction });

  await publishGuaranteedRentPaid(guaranteedRentContract, period, transaction);

  await registrarAuditoria(
    {
      groupId: guaranteedRentContract.groupId,
      companyId: guaranteedRentContract.companyId,
      actorUserId,
      action: 'billing.guaranteed_rent.pay',
      entityType: 'GuaranteedRentContract',
      entityId: guaranteedRentContract.id,
      beforeJson,
      afterJson: guaranteedRentContract.toJSON(),
      reason: `Aluguel garantido pago ao proprietário (${numericAmount}) e crédito a recuperar do locatário criado, competência ${period}.`,
    },
    transaction
  );

  return { guaranteedRentContract, payableEntry, receivableEntry };
}

module.exports = {
  enrollGuaranteedRent,
  getGuaranteedRentContract,
  listGuaranteedRentContracts,
  payGuaranteedRent,
};
