'use strict';

const { BankTransaction } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

// finance.bank_transactions representa linhas de extrato importadas. `externalTransactionId`
// (UNIQUE) é a idempotência natural de um import — reprocessar o mesmo arquivo/webhook não
// duplica a linha (FIN-004), então createBankTransaction checa antes de inserir e explica o
// motivo do 409 em vez de deixar estourar a constraint de banco crua.

async function createBankTransaction(payload, actorUserId, transaction) {
  const { groupId, companyId, bankAccountId, externalTransactionId, amount, transactionDate, description } = payload;
  if (!groupId || !companyId || !bankAccountId || amount === undefined || amount === null || !transactionDate) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "bankAccountId", "amount" e "transactionDate" são obrigatórios.',
      'FINANCE_BANK_TRANSACTION_VALIDATION'
    );
  }

  if (externalTransactionId) {
    const existing = await BankTransaction.findOne({ where: { externalTransactionId }, transaction });
    if (existing) {
      throw AppError.conflict(
        'Já existe uma transação importada com este mesmo identificador externo — import duplicado bloqueado.',
        'FINANCE_BANK_TRANSACTION_DUPLICATE',
        { existingId: existing.id }
      );
    }
  }

  const bankTransaction = await BankTransaction.create(
    {
      groupId,
      companyId,
      bankAccountId,
      externalTransactionId: externalTransactionId || null,
      amount,
      transactionDate,
      description: description || null,
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
      action: 'finance.bank_transaction.create',
      entityType: 'BankTransaction',
      entityId: bankTransaction.id,
      afterJson: bankTransaction.toJSON(),
      reason: `Transação de extrato de ${amount} importada.`,
    },
    transaction
  );

  return bankTransaction;
}

async function listBankTransactions(transaction, filters = {}) {
  const where = {};
  if (filters.bankAccountId) where.bankAccountId = filters.bankAccountId;
  return BankTransaction.findAll({ where, order: [['transaction_date', 'DESC']], transaction });
}

async function getBankTransaction(id, transaction) {
  const bankTransaction = await BankTransaction.findByPk(id, { transaction });
  if (!bankTransaction) throw AppError.notFound('Transação bancária não encontrada.', 'FINANCE_BANK_TRANSACTION_NOT_FOUND');
  return bankTransaction;
}

module.exports = { createBankTransaction, listBankTransactions, getBankTransaction };
