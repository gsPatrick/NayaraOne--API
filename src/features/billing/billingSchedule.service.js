'use strict';

const { BillingSchedule, BillingScheduleItem, Contract } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishBillingGenerated } = require('./billingEvents.service');

const COMPONENT_TYPES = ['RENT', 'CONDO', 'IPTU', 'OTHER'];
const PERIOD_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertValidPeriod(period) {
  if (!period || !PERIOD_REGEX.test(period)) {
    throw AppError.badRequest('O campo "period" deve estar no formato "YYYY-MM".', 'BILLING_SCHEDULE_VALIDATION');
  }
}

/**
 * generateBillingSchedule — gera o cronograma de cobrança (uma competência) de um contrato de
 * locação, com os componentes informados (aluguel, condomínio, IPTU, etc.).
 *
 * Competência é ÚNICA por contrato (UNIQUE (contract_id, period) no banco — ver migration
 * 20260101000102). Se já existir, retornamos erro claro (409) em vez de deixar o Postgres
 * estourar um erro de constraint genérico para o cliente da API.
 */
async function generateBillingSchedule(payload, actorUserId, transaction) {
  const { groupId, companyId, contractId, period, dueDate, items } = payload;

  if (!groupId || !companyId || !contractId || !dueDate) {
    throw AppError.badRequest('Os campos "groupId", "companyId", "contractId" e "dueDate" são obrigatórios.', 'BILLING_SCHEDULE_VALIDATION');
  }
  assertValidPeriod(period);
  if (!Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('O campo "items" deve ser uma lista não vazia de componentes de cobrança.', 'BILLING_SCHEDULE_VALIDATION');
  }
  for (const item of items) {
    const componentType = String(item.componentType || '').toUpperCase();
    if (!COMPONENT_TYPES.includes(componentType)) {
      throw AppError.badRequest(`"componentType" deve ser um de: ${COMPONENT_TYPES.join(', ')}.`, 'BILLING_SCHEDULE_VALIDATION');
    }
    const amount = Number(item.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw AppError.badRequest('Cada item precisa de "amount" numérico positivo.', 'BILLING_SCHEDULE_VALIDATION');
    }
  }

  const contract = await Contract.findByPk(contractId, { transaction });
  if (!contract) {
    throw AppError.notFound('Contrato não encontrado.', 'BILLING_SCHEDULE_CONTRACT_NOT_FOUND');
  }

  const existing = await BillingSchedule.findOne({ where: { contractId, period }, transaction });
  if (existing) {
    throw AppError.conflict(
      `Já existe cronograma de cobrança gerado para o contrato ${contractId} na competência "${period}".`,
      'BILLING_SCHEDULE_DUPLICATE_PERIOD'
    );
  }

  const totalAmount = items.reduce((sum, item) => sum + Number(item.amount), 0);

  const billingSchedule = await BillingSchedule.create(
    {
      groupId,
      companyId,
      contractId,
      period,
      dueDate,
      totalAmount,
      paidAmount: 0,
      balance: totalAmount,
      status: 'OPEN',
      generatedAt: new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  for (const item of items) {
    await BillingScheduleItem.create(
      {
        groupId,
        companyId,
        billingScheduleId: billingSchedule.id,
        componentType: String(item.componentType).toUpperCase(),
        description: item.description || null,
        amount: item.amount,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }

  await publishBillingGenerated(billingSchedule, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'billing.schedule.generate',
      entityType: 'BillingSchedule',
      entityId: billingSchedule.id,
      afterJson: billingSchedule.toJSON(),
      reason: `Cronograma de cobrança gerado para o contrato ${contractId}, competência "${period}", total ${totalAmount}.`,
    },
    transaction
  );

  return billingSchedule;
}

async function getBillingSchedule(id, transaction) {
  const billingSchedule = await BillingSchedule.findByPk(id, { include: [{ model: BillingScheduleItem, as: 'items' }], transaction });
  if (!billingSchedule) throw AppError.notFound('Cronograma de cobrança não encontrado.', 'BILLING_SCHEDULE_NOT_FOUND');
  return billingSchedule;
}

async function listBillingSchedules(transaction, filters = {}) {
  const where = {};
  if (filters.contractId) where.contractId = filters.contractId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return BillingSchedule.findAll({ where, order: [['due_date', 'ASC']], transaction });
}

/**
 * registerPayment — registra um pagamento (total ou parcial) contra uma competência.
 * Pagamento PARCIAL recompõe o saldo (balance = total - paidAmount) e mantém status
 * PARTIALLY_PAID — a cobrança só fecha (status PAID) quando balance chega a zero. Nunca fecha
 * a cobrança "por engano" com saldo residual positivo.
 */
async function registerPayment(id, amountPaid, actorUserId, transaction) {
  // FIX (homologação 23/09/2026): sem lock pessimista aqui, duas chamadas concorrentes de
  // registerPayment para a mesma competência liam o mesmo paidAmount/balance e a segunda
  // sobrescrevia o resultado da primeira (lost update) — permitindo baixa duplicada não
  // contabilizada ou saldo final incorreto. Mesmo padrão de lock já usado em
  // settleFinancialEntryPartial (financialEntries.service.js). O lock é pego numa consulta
  // separada, sem include, porque `SELECT ... FOR UPDATE` não é compatível com o LEFT JOIN
  // de `items` que getBillingSchedule usa.
  const lockedRow = await BillingSchedule.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!lockedRow) throw AppError.notFound('Cronograma de cobrança não encontrado.', 'BILLING_SCHEDULE_NOT_FOUND');

  const billingSchedule = await getBillingSchedule(id, transaction);
  const amount = Number(amountPaid);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw AppError.badRequest('"amountPaid" deve ser um número positivo.', 'BILLING_SCHEDULE_PAYMENT_VALIDATION');
  }
  if (billingSchedule.status === 'PAID') {
    throw AppError.conflict('Esta competência já está totalmente quitada.', 'BILLING_SCHEDULE_ALREADY_PAID');
  }
  const beforeJson = billingSchedule.toJSON();

  const newPaidAmount = Number(billingSchedule.paidAmount) + amount;
  const newBalance = Number(billingSchedule.totalAmount) - newPaidAmount;

  if (newBalance < 0) {
    throw AppError.badRequest(
      `Pagamento de ${amount} excede o saldo em aberto (${billingSchedule.balance}) desta competência.`,
      'BILLING_SCHEDULE_OVERPAYMENT'
    );
  }

  billingSchedule.paidAmount = newPaidAmount;
  billingSchedule.balance = newBalance;
  billingSchedule.status = newBalance === 0 ? 'PAID' : 'PARTIALLY_PAID';
  billingSchedule.updatedBy = actorUserId || null;
  await billingSchedule.save({ transaction });

  await registrarAuditoria(
    {
      groupId: billingSchedule.groupId,
      companyId: billingSchedule.companyId,
      actorUserId,
      action: 'billing.schedule.register_payment',
      entityType: 'BillingSchedule',
      entityId: billingSchedule.id,
      beforeJson,
      afterJson: billingSchedule.toJSON(),
      reason: `Pagamento de ${amount} registrado (saldo remanescente: ${newBalance}).`,
    },
    transaction
  );

  return billingSchedule;
}

module.exports = {
  generateBillingSchedule,
  getBillingSchedule,
  listBillingSchedules,
  registerPayment,
  COMPONENT_TYPES,
};
