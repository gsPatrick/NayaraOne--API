'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');

// Publicação dos domain events do módulo finance (Transactional Outbox), seguindo o mesmo
// padrão de src/features/properties/propertyEvents.service.js e
// src/features/crm/opportunityEvents.service.js — sempre dentro da MESMA transação da
// operação de negócio.

function publishBankAccountCreated(bankAccount, transaction) {
  return publishDomainEvent(
    {
      groupId: bankAccount.groupId,
      companyId: bankAccount.companyId,
      aggregateType: 'BankAccount',
      aggregateId: bankAccount.id,
      eventType: 'finance.bank_account.created',
      payload: { id: bankAccount.id, status: bankAccount.status },
      idempotencyKey: `finance.bank_account.created:${bankAccount.id}`,
    },
    transaction
  );
}

function publishBankAccountSensitiveDataChanged(bankAccount, transaction) {
  return publishDomainEvent(
    {
      groupId: bankAccount.groupId,
      companyId: bankAccount.companyId,
      aggregateType: 'BankAccount',
      aggregateId: bankAccount.id,
      eventType: 'finance.bank_account.sensitive_data_changed',
      payload: { id: bankAccount.id, status: bankAccount.status },
      idempotencyKey: `finance.bank_account.sensitive_data_changed:${bankAccount.id}:${Date.now()}`,
    },
    transaction
  );
}

function publishFinancialEntryCreated(entry, transaction) {
  return publishDomainEvent(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      aggregateType: 'FinancialEntry',
      aggregateId: entry.id,
      eventType: 'finance.entry.created',
      payload: { id: entry.id, nature: entry.nature, entryType: entry.entryType, amount: entry.amount, status: entry.status },
      idempotencyKey: `finance.entry.created:${entry.id}`,
    },
    transaction
  );
}

function publishFinancialEntrySettled(entry, transaction) {
  return publishDomainEvent(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      aggregateType: 'FinancialEntry',
      aggregateId: entry.id,
      eventType: 'finance.entry.settled',
      payload: { id: entry.id, amount: entry.amount, settledAt: entry.settledAt },
      idempotencyKey: `finance.entry.settled:${entry.id}`,
    },
    transaction
  );
}

function publishFinancialEntryReversed(originalEntry, reversalEntry, transaction) {
  return publishDomainEvent(
    {
      groupId: originalEntry.groupId,
      companyId: originalEntry.companyId,
      aggregateType: 'FinancialEntry',
      aggregateId: originalEntry.id,
      eventType: 'finance.entry.reversed',
      payload: { originalEntryId: originalEntry.id, reversalEntryId: reversalEntry.id, amount: reversalEntry.amount },
      idempotencyKey: `finance.entry.reversed:${originalEntry.id}`,
    },
    transaction
  );
}

function publishReconciliationMatched(reconciliation, transaction) {
  return publishDomainEvent(
    {
      groupId: reconciliation.groupId,
      companyId: reconciliation.companyId,
      aggregateType: 'Reconciliation',
      aggregateId: reconciliation.id,
      eventType: 'finance.reconciliation.matched',
      payload: {
        id: reconciliation.id,
        financialEntryId: reconciliation.financialEntryId,
        bankTransactionId: reconciliation.bankTransactionId,
      },
      idempotencyKey: `finance.reconciliation.matched:${reconciliation.financialEntryId}:${reconciliation.bankTransactionId}`,
    },
    transaction
  );
}

function publishApprovalRequestCreated(approvalRequest, transaction) {
  return publishDomainEvent(
    {
      groupId: approvalRequest.groupId,
      companyId: approvalRequest.companyId,
      aggregateType: 'ApprovalRequest',
      aggregateId: approvalRequest.id,
      eventType: 'finance.approval_request.created',
      payload: {
        id: approvalRequest.id,
        relatedEntityType: approvalRequest.relatedEntityType,
        relatedEntityId: approvalRequest.relatedEntityId,
        riskLevel: approvalRequest.riskLevel,
      },
      idempotencyKey: `finance.approval_request.created:${approvalRequest.id}`,
    },
    transaction
  );
}

function publishApprovalStepDecided(approvalStep, transaction) {
  return publishDomainEvent(
    {
      groupId: approvalStep.groupId,
      companyId: approvalStep.companyId,
      aggregateType: 'ApprovalStep',
      aggregateId: approvalStep.id,
      eventType: 'finance.approval_step.decided',
      payload: {
        id: approvalStep.id,
        approvalRequestId: approvalStep.approvalRequestId,
        decision: approvalStep.decision,
      },
      idempotencyKey: `finance.approval_step.decided:${approvalStep.id}`,
    },
    transaction
  );
}

function publishCommissionCreated(commission, transaction) {
  return publishDomainEvent(
    {
      groupId: commission.groupId,
      companyId: commission.companyId,
      aggregateType: 'Commission',
      aggregateId: commission.id,
      eventType: 'finance.commission.created',
      payload: { id: commission.id, totalAmount: commission.totalAmount, beneficiaryUserId: commission.beneficiaryUserId },
      idempotencyKey: `finance.commission.created:${commission.id}`,
    },
    transaction
  );
}

function publishOwnerRepasseCreated(repasse, transaction) {
  return publishDomainEvent(
    {
      groupId: repasse.groupId,
      companyId: repasse.companyId,
      aggregateType: 'OwnerRepass',
      aggregateId: repasse.id,
      eventType: 'finance.owner_repasse.created',
      payload: { id: repasse.id, netAmount: repasse.netAmount, referenceMonth: repasse.referenceMonth },
      idempotencyKey: `finance.owner_repasse.created:${repasse.id}`,
    },
    transaction
  );
}

module.exports = {
  publishBankAccountCreated,
  publishBankAccountSensitiveDataChanged,
  publishFinancialEntryCreated,
  publishFinancialEntrySettled,
  publishFinancialEntryReversed,
  publishReconciliationMatched,
  publishApprovalRequestCreated,
  publishApprovalStepDecided,
  publishCommissionCreated,
  publishOwnerRepasseCreated,
};
