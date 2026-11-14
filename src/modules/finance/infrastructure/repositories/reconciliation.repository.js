'use strict';

const { Op } = require('sequelize');

const { Reconciliation, FinancialEntry, BankTransaction } = require('../../../../models');

// Acesso a dados da conciliação (reconciliations, e as leituras de financial_entries e
// bank_transactions que a conciliação faz). Toda função recebe a transação.

// FOR UPDATE: serializa conciliações concorrentes sobre o mesmo lançamento.
async function findFinancialEntryForUpdate(financialEntryId, transaction) {
  return FinancialEntry.findByPk(financialEntryId, { transaction, lock: transaction.LOCK.UPDATE });
}

// FOR UPDATE: serializa conciliações concorrentes sobre a mesma transação de extrato.
async function findBankTransactionForUpdate(bankTransactionId, transaction) {
  return BankTransaction.findByPk(bankTransactionId, { transaction, lock: transaction.LOCK.UPDATE });
}

async function findBankTransactionById(bankTransactionId, transaction) {
  return BankTransaction.findByPk(bankTransactionId, { transaction });
}

async function findFinancialEntryById(financialEntryId, transaction) {
  return FinancialEntry.findByPk(financialEntryId, { transaction });
}

async function findReconciliationByFinancialEntry(financialEntryId, transaction) {
  return Reconciliation.findOne({ where: { financialEntryId }, transaction });
}

async function findReconciliationByBankTransaction(bankTransactionId, transaction) {
  return Reconciliation.findOne({ where: { bankTransactionId }, transaction });
}

async function createReconciliation(data, transaction) {
  return Reconciliation.create(data, { transaction });
}

async function listReconciliations(where, transaction) {
  return Reconciliation.findAll({ where, order: [['matched_at', 'DESC']], transaction });
}

// Lançamentos em aberto da empresa (candidatos à sugestão de conciliação).
async function findOpenFinancialEntriesByCompany(companyId, transaction) {
  return FinancialEntry.findAll({
    where: { companyId, status: { [Op.in]: ['PENDING', 'PARTIALLY_SETTLED'] } },
    transaction,
  });
}

async function findReconciliationsByCompany(companyId, transaction) {
  return Reconciliation.findAll({ where: { companyId }, transaction });
}

module.exports = {
  findFinancialEntryForUpdate,
  findBankTransactionForUpdate,
  findBankTransactionById,
  findFinancialEntryById,
  findReconciliationByFinancialEntry,
  findReconciliationByBankTransaction,
  createReconciliation,
  listReconciliations,
  findOpenFinancialEntriesByCompany,
  findReconciliationsByCompany,
};
