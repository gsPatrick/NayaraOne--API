'use strict';

const { BankAccount } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishBankAccountCreated, publishBankAccountSensitiveDataChanged } = require('./financeEvents.service');

// Campos sensíveis: alterá-los reabre o cooldown antifraude (mesma regra de "conta nova"),
// porque uma troca desses dados é exatamente o vetor de fraude que o período de resfriamento
// existe para conter (ver financeAntifraud.service.js).
const SENSITIVE_FIELDS = ['bankCode', 'agency', 'accountNumber', 'pixKey'];
const STATUSES = ['PENDING_COOLDOWN', 'ACTIVE', 'BLOCKED'];

async function createBankAccount(payload, actorUserId, transaction) {
  const { groupId, companyId, ownerPersonId, bankCode, agency, accountNumber, pixKey } = payload;
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'FINANCE_BANK_ACCOUNT_VALIDATION');
  }
  if (!bankCode && !pixKey) {
    throw AppError.badRequest(
      'Informe ao menos "bankCode"+"accountNumber" ou uma "pixKey" para identificar a conta.',
      'FINANCE_BANK_ACCOUNT_VALIDATION'
    );
  }

  const bankAccount = await BankAccount.create(
    {
      groupId,
      companyId,
      ownerPersonId: ownerPersonId || null,
      bankCode: bankCode || null,
      agency: agency || null,
      accountNumber: accountNumber || null,
      pixKey: pixKey || null,
      status: 'PENDING_COOLDOWN',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishBankAccountCreated(bankAccount, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.bank_account.create',
      entityType: 'BankAccount',
      entityId: bankAccount.id,
      afterJson: bankAccount.toJSON(),
      reason: 'Conta bancária cadastrada — em período de resfriamento antes de poder receber pagamentos.',
    },
    transaction
  );

  return bankAccount;
}

async function listBankAccounts(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.ownerPersonId) where.ownerPersonId = filters.ownerPersonId;
  return BankAccount.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getBankAccount(id, transaction) {
  const bankAccount = await BankAccount.findByPk(id, { transaction });
  if (!bankAccount) throw AppError.notFound('Conta bancária não encontrada.', 'FINANCE_BANK_ACCOUNT_NOT_FOUND');
  return bankAccount;
}

/**
 * updateBankAccount — se algum campo sensível (dados bancários/PIX) mudar, a conta volta pra
 * PENDING_COOLDOWN automaticamente (reabre o resfriamento antifraude), mesmo que já estivesse
 * ACTIVE. Isso é a regra "mudança bancária + pagamento em janela curta → bloquear" aplicada do
 * lado da conta (o lado do pagamento é bloqueado por financeAntifraud.assertBankAccountEligibleForPayment).
 */
async function updateBankAccount(id, payload, actorUserId, transaction) {
  const bankAccount = await getBankAccount(id, transaction);
  const beforeJson = bankAccount.toJSON();
  const { ownerPersonId, bankCode, agency, accountNumber, pixKey, status } = payload;

  let sensitiveChanged = false;
  if (bankCode !== undefined && bankCode !== bankAccount.bankCode) { bankAccount.bankCode = bankCode; sensitiveChanged = true; }
  if (agency !== undefined && agency !== bankAccount.agency) { bankAccount.agency = agency; sensitiveChanged = true; }
  if (accountNumber !== undefined && accountNumber !== bankAccount.accountNumber) { bankAccount.accountNumber = accountNumber; sensitiveChanged = true; }
  if (pixKey !== undefined && pixKey !== bankAccount.pixKey) { bankAccount.pixKey = pixKey; sensitiveChanged = true; }
  if (ownerPersonId !== undefined) bankAccount.ownerPersonId = ownerPersonId;

  if (status !== undefined) {
    const normalized = String(status).toUpperCase();
    if (!STATUSES.includes(normalized)) {
      throw AppError.badRequest(`O campo "status" deve ser um de: ${STATUSES.join(', ')}.`, 'FINANCE_BANK_ACCOUNT_VALIDATION');
    }
    // Reativação manual pós-bloqueio, por exemplo — não pula o cooldown se ainda dentro dele;
    // quem decide isso é financeAntifraud.assertBankAccountEligibleForPayment no momento do pagamento.
    bankAccount.status = normalized;
  }

  if (sensitiveChanged && bankAccount.status !== 'BLOCKED') {
    bankAccount.status = 'PENDING_COOLDOWN';
  }

  bankAccount.updatedBy = actorUserId || null;
  await bankAccount.save({ transaction });

  if (sensitiveChanged) {
    await publishBankAccountSensitiveDataChanged(bankAccount, transaction);
  }

  await registrarAuditoria(
    {
      groupId: bankAccount.groupId,
      companyId: bankAccount.companyId,
      actorUserId,
      action: sensitiveChanged ? 'finance.bank_account.sensitive_data_changed' : 'finance.bank_account.update',
      entityType: 'BankAccount',
      entityId: bankAccount.id,
      beforeJson,
      afterJson: bankAccount.toJSON(),
      reason: sensitiveChanged
        ? 'Dados bancários sensíveis alterados — conta voltou para período de resfriamento (antifraude).'
        : 'Conta bancária atualizada.',
    },
    transaction
  );

  return bankAccount;
}

async function blockBankAccount(id, reason, actorUserId, transaction) {
  const bankAccount = await getBankAccount(id, transaction);
  const beforeJson = bankAccount.toJSON();
  bankAccount.status = 'BLOCKED';
  bankAccount.updatedBy = actorUserId || null;
  await bankAccount.save({ transaction });

  await registrarAuditoria(
    {
      groupId: bankAccount.groupId,
      companyId: bankAccount.companyId,
      actorUserId,
      action: 'finance.bank_account.block',
      entityType: 'BankAccount',
      entityId: bankAccount.id,
      beforeJson,
      afterJson: bankAccount.toJSON(),
      reason: reason ? `Conta bancária bloqueada: ${reason}` : 'Conta bancária bloqueada (antifraude).',
    },
    transaction
  );

  return bankAccount;
}

async function deleteBankAccount(id, actorUserId, transaction) {
  const bankAccount = await getBankAccount(id, transaction);
  const beforeJson = bankAccount.toJSON();
  bankAccount.deletedBy = actorUserId || null;
  await bankAccount.save({ transaction });
  await bankAccount.destroy({ transaction });

  await registrarAuditoria(
    {
      groupId: bankAccount.groupId,
      companyId: bankAccount.companyId,
      actorUserId,
      action: 'finance.bank_account.delete',
      entityType: 'BankAccount',
      entityId: bankAccount.id,
      beforeJson,
      reason: 'Conta bancária excluída.',
    },
    transaction
  );

  return { id };
}

module.exports = {
  createBankAccount,
  listBankAccounts,
  getBankAccount,
  updateBankAccount,
  blockBankAccount,
  deleteBankAccount,
  SENSITIVE_FIELDS,
  STATUSES,
};
