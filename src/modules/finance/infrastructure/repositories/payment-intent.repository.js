'use strict';

/**
 * Repositório da intenção de pagamento (Guia M4 §2). Todo acesso a dados de finance.payment_intents, do
 * roteamento do id externo do banco (finance.bank_payment_provider_routing) e da conta de destino que o
 * pagamento confere. Cada função recebe a transação; as consultas e travas são as mesmas que estavam nos
 * serviços.
 */
const { PaymentIntent, BankAccount, BankPaymentProviderRouting, AnomalyCase } = require('../../../../models');

const forUpdate = (transaction) => (transaction ? transaction.LOCK.UPDATE : undefined);

function findById(id, transaction) {
  return PaymentIntent.findByPk(id, { transaction });
}

// Variante com lock pessimista, usada pelas transições de status (approve/execute/cancel) —
// sem isso, duas chamadas concorrentes (duplo clique, retry de rede) leem o mesmo status
// "de origem" antes de qualquer uma commitar e ambas transicionam.
function findByIdForUpdate(id, transaction) {
  return PaymentIntent.findByPk(id, { transaction, lock: forUpdate(transaction) });
}

/** Intenção do lançamento num dos estados informados (ex.: em aberto). */
function findOneForEntry(financialEntryId, statuses, transaction) {
  return PaymentIntent.findOne({ where: { financialEntryId, status: statuses }, transaction });
}

/** Intenções do lançamento nos estados informados, com lock (invalidação depois de uma edição). */
function findForEntryForUpdate(financialEntryId, statuses, transaction) {
  return PaymentIntent.findAll({ where: { financialEntryId, status: statuses }, transaction, lock: forUpdate(transaction) });
}

/** Intenções nos estados informados que congelaram esta conta de destino, com lock (troca do favorecido). */
function findForBankAccountForUpdate(bankAccountId, statuses, transaction) {
  return PaymentIntent.findAll({ where: { bankAccountId, status: statuses }, transaction, lock: forUpdate(transaction) });
}

/** Caso de anomalia ainda aberto de um tipo para a intenção (um por intenção). */
function findOpenAnomaly(paymentIntentId, caseType, transaction) {
  return AnomalyCase.findOne({ where: { relatedEntityType: 'PaymentIntent', relatedEntityId: paymentIntentId, caseType, status: 'OPEN' }, transaction });
}

function countForEntry(financialEntryId, statuses, transaction) {
  return PaymentIntent.count({ where: { financialEntryId, status: statuses }, transaction });
}

function create(values, transaction) {
  return PaymentIntent.create(values, { transaction });
}

function save(intent, transaction) {
  return intent.save({ transaction });
}

function list(where, transaction) {
  return PaymentIntent.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

function findRouting(externalSubmissionId, transaction) {
  return BankPaymentProviderRouting.findOne({ where: { externalSubmissionId }, transaction });
}

function createRouting(values, transaction) {
  return BankPaymentProviderRouting.create(values, { transaction });
}

function findBankAccount(id, transaction) {
  return BankAccount.findByPk(id, { transaction });
}

module.exports = {
  findById,
  findByIdForUpdate,
  findOneForEntry,
  findForEntryForUpdate,
  countForEntry,
  findForBankAccountForUpdate,
  findOpenAnomaly,
  create,
  save,
  list,
  findRouting,
  createRouting,
  findBankAccount,
};
