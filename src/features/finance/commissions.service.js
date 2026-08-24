'use strict';

const { Commission, CommissionInstallment } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishCommissionCreated } = require('./financeEvents.service');

const STATUSES = ['PENDING', 'APPROVED', 'PAID', 'CANCELLED'];

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * createCommission — registra o DIREITO à comissão (baseAmount × percentage = totalAmount).
 * `ruleVersionId` (opcional) rastreia qual versão da regra de comissionamento vigente gerou
 * esse cálculo, para auditoria futura (coluna já existe no schema, sem FK de banco — ver
 * comentário do model).
 */
async function createCommission(payload, actorUserId, transaction) {
  const { groupId, companyId, opportunityId, contractId, beneficiaryUserId, baseAmount, percentage, ruleVersionId, installmentsCount, firstDueAt } = payload;

  if (!groupId || !companyId || !beneficiaryUserId || baseAmount === undefined || percentage === undefined) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "beneficiaryUserId", "baseAmount" e "percentage" são obrigatórios.',
      'FINANCE_COMMISSION_VALIDATION'
    );
  }
  const baseNumeric = Number(baseAmount);
  const percentageNumeric = Number(percentage);
  if (!Number.isFinite(baseNumeric) || baseNumeric <= 0) {
    throw AppError.badRequest('O campo "baseAmount" deve ser um número positivo.', 'FINANCE_COMMISSION_VALIDATION');
  }
  if (!Number.isFinite(percentageNumeric) || percentageNumeric <= 0 || percentageNumeric > 100) {
    throw AppError.badRequest('O campo "percentage" deve estar entre 0 (exclusivo) e 100.', 'FINANCE_COMMISSION_VALIDATION');
  }

  const totalAmount = round2(baseNumeric * (percentageNumeric / 100));

  const commission = await Commission.create(
    {
      groupId,
      companyId,
      opportunityId: opportunityId || null,
      contractId: contractId || null,
      beneficiaryUserId,
      baseAmount: baseNumeric,
      percentage: percentageNumeric,
      totalAmount,
      ruleVersionId: ruleVersionId || null,
      status: 'PENDING',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  const installments = await generateInstallments(commission, installmentsCount || 1, firstDueAt, actorUserId, transaction);

  await publishCommissionCreated(commission, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.commission.create',
      entityType: 'Commission',
      entityId: commission.id,
      afterJson: { commission: commission.toJSON(), installments: installments.map((i) => i.toJSON()) },
      reason: `Comissão de ${totalAmount} (${percentageNumeric}% sobre ${baseNumeric}) registrada.`,
    },
    transaction
  );

  return { commission, installments };
}

/**
 * generateInstallments — divide totalAmount em N parcelas iguais (a última absorve a diferença
 * de arredondamento, pra soma das parcelas nunca ficar diferente do totalAmount por causa de
 * centavos — problema clássico de divisão de moeda).
 */
async function generateInstallments(commission, count, firstDueAt, actorUserId, transaction) {
  const n = Math.max(1, Number(count) || 1);
  const baseInstallment = Math.floor((commission.totalAmount / n) * 100) / 100;
  const installments = [];
  let allocated = 0;
  const startDate = firstDueAt ? new Date(firstDueAt) : new Date();

  for (let i = 1; i <= n; i += 1) {
    const isLast = i === n;
    const amount = isLast ? round2(commission.totalAmount - allocated) : baseInstallment;
    allocated = round2(allocated + amount);

    const dueAt = new Date(startDate);
    dueAt.setMonth(dueAt.getMonth() + (i - 1));

    // eslint-disable-next-line no-await-in-loop
    const installment = await CommissionInstallment.create(
      {
        groupId: commission.groupId,
        companyId: commission.companyId,
        commissionId: commission.id,
        installmentNumber: i,
        amount,
        dueAt,
        paidAt: null,
        financialEntryId: null,
        status: 'PENDING',
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
    installments.push(installment);
  }

  return installments;
}

async function listCommissions(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.beneficiaryUserId) where.beneficiaryUserId = filters.beneficiaryUserId;
  return Commission.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getCommission(id, transaction) {
  const commission = await Commission.findByPk(id, { transaction });
  if (!commission) throw AppError.notFound('Comissão não encontrada.', 'FINANCE_COMMISSION_NOT_FOUND');
  return commission;
}

async function listCommissionInstallments(commissionId, transaction) {
  return CommissionInstallment.findAll({ where: { commissionId }, order: [['installment_number', 'ASC']], transaction });
}

/**
 * markInstallmentPaid — vincula a parcela a um lançamento financeiro (financialEntryId) já
 * liquidado — não gera dinheiro novo, só registra a baixa da parcela contra um lançamento real
 * do ledger, evitando dupla contagem.
 */
async function markInstallmentPaid(installmentId, financialEntryId, actorUserId, transaction) {
  const installment = await CommissionInstallment.findByPk(installmentId, { transaction });
  if (!installment) throw AppError.notFound('Parcela de comissão não encontrada.', 'FINANCE_COMMISSION_INSTALLMENT_NOT_FOUND');
  if (installment.status === 'PAID') {
    throw AppError.conflict('Esta parcela já está paga.', 'FINANCE_COMMISSION_INSTALLMENT_ALREADY_PAID');
  }
  const beforeJson = installment.toJSON();
  installment.status = 'PAID';
  installment.paidAt = new Date();
  installment.financialEntryId = financialEntryId || null;
  installment.updatedBy = actorUserId || null;
  await installment.save({ transaction });

  await registrarAuditoria(
    {
      groupId: installment.groupId,
      companyId: installment.companyId,
      actorUserId,
      action: 'finance.commission_installment.pay',
      entityType: 'CommissionInstallment',
      entityId: installment.id,
      beforeJson,
      afterJson: installment.toJSON(),
      reason: `Parcela ${installment.installmentNumber} da comissão paga (${installment.amount}).`,
    },
    transaction
  );

  return installment;
}

module.exports = {
  createCommission,
  listCommissions,
  getCommission,
  listCommissionInstallments,
  markInstallmentPaid,
  STATUSES,
};
