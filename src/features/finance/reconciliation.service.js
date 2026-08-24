'use strict';

const { Reconciliation, FinancialEntry, BankTransaction } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishReconciliationMatched } = require('./financeEvents.service');

// Motor de conciliação — casa um finance.financial_entries (lançamento) com um
// finance.bank_transactions (linha real de extrato). Regras duras:
//   - valores devem bater (mesmo módulo, tolerância zero — nenhuma "reconciliação aproximada"
//     está prevista no schema/documento);
//   - nem o lançamento nem a transação podem já estar conciliados com outra coisa (1:1).

async function assertNotAlreadyReconciled(financialEntryId, bankTransactionId, transaction) {
  const existingForEntry = await Reconciliation.findOne({ where: { financialEntryId }, transaction });
  if (existingForEntry) {
    throw AppError.conflict('Este lançamento financeiro já está conciliado com outra transação.', 'FINANCE_RECONCILIATION_ENTRY_ALREADY_MATCHED');
  }
  const existingForTransaction = await Reconciliation.findOne({ where: { bankTransactionId }, transaction });
  if (existingForTransaction) {
    throw AppError.conflict('Esta transação de extrato já está conciliada com outro lançamento.', 'FINANCE_RECONCILIATION_TRANSACTION_ALREADY_MATCHED');
  }
}

async function matchReconciliation(payload, actorUserId, transaction) {
  const { groupId, companyId, financialEntryId, bankTransactionId } = payload;
  if (!groupId || !companyId || !financialEntryId || !bankTransactionId) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "financialEntryId" e "bankTransactionId" são obrigatórios.',
      'FINANCE_RECONCILIATION_VALIDATION'
    );
  }

  const entry = await FinancialEntry.findByPk(financialEntryId, { transaction });
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  const bankTransaction = await BankTransaction.findByPk(bankTransactionId, { transaction });
  if (!bankTransaction) throw AppError.notFound('Transação bancária não encontrada.', 'FINANCE_BANK_TRANSACTION_NOT_FOUND');

  if (Number(entry.amount) !== Math.abs(Number(bankTransaction.amount))) {
    throw AppError.conflict(
      `Valores não batem: lançamento ${entry.amount} vs. transação ${bankTransaction.amount}. Conciliação bloqueada.`,
      'FINANCE_RECONCILIATION_AMOUNT_MISMATCH'
    );
  }

  await assertNotAlreadyReconciled(financialEntryId, bankTransactionId, transaction);

  const reconciliation = await Reconciliation.create(
    {
      groupId,
      companyId,
      financialEntryId,
      bankTransactionId,
      matchedAt: new Date(),
      matchedByUserId: actorUserId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishReconciliationMatched(reconciliation, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.reconciliation.match',
      entityType: 'Reconciliation',
      entityId: reconciliation.id,
      afterJson: reconciliation.toJSON(),
      reason: `Lançamento financeiro conciliado com transação de extrato (valor ${entry.amount}).`,
    },
    transaction
  );

  return reconciliation;
}

async function listReconciliations(transaction, filters = {}) {
  const where = {};
  if (filters.financialEntryId) where.financialEntryId = filters.financialEntryId;
  if (filters.bankTransactionId) where.bankTransactionId = filters.bankTransactionId;
  return Reconciliation.findAll({ where, order: [['matched_at', 'DESC']], transaction });
}

module.exports = { matchReconciliation, listReconciliations };
