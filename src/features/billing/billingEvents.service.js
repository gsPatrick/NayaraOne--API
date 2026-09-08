'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');

// Publicação dos domain events do módulo billing (Transactional Outbox), mesmo padrão de
// src/features/finance/financeEvents.service.js e src/features/legal/legalEvents.service.js —
// sempre dentro da MESMA transação da operação de negócio que originou o evento.

function publishBillingGenerated(billingSchedule, transaction) {
  return publishDomainEvent(
    {
      groupId: billingSchedule.groupId,
      companyId: billingSchedule.companyId,
      aggregateType: 'BillingSchedule',
      aggregateId: billingSchedule.id,
      eventType: 'billing.generated',
      payload: { id: billingSchedule.id, contractId: billingSchedule.contractId, period: billingSchedule.period, totalAmount: billingSchedule.totalAmount },
      idempotencyKey: `billing.generated:${billingSchedule.id}`,
    },
    transaction
  );
}

function publishRentAdjusted(rentAdjustment, transaction) {
  return publishDomainEvent(
    {
      groupId: rentAdjustment.groupId,
      companyId: rentAdjustment.companyId,
      aggregateType: 'RentAdjustment',
      aggregateId: rentAdjustment.id,
      eventType: 'rent.adjusted',
      payload: {
        id: rentAdjustment.id,
        contractId: rentAdjustment.contractId,
        period: rentAdjustment.period,
        status: rentAdjustment.status,
        newRentAmount: rentAdjustment.newRentAmount,
      },
      idempotencyKey: `rent.adjusted:${rentAdjustment.id}:${rentAdjustment.status}`,
    },
    transaction
  );
}

function publishChargeOverdue(collectionCase, transaction) {
  return publishDomainEvent(
    {
      groupId: collectionCase.groupId,
      companyId: collectionCase.companyId,
      aggregateType: 'CollectionCase',
      aggregateId: collectionCase.id,
      eventType: 'charge.overdue',
      payload: { id: collectionCase.id, contractId: collectionCase.contractId, billingScheduleId: collectionCase.billingScheduleId },
      idempotencyKey: `charge.overdue:${collectionCase.id}`,
    },
    transaction
  );
}

function publishGuaranteedRentPaid(guaranteedRentContract, period, transaction) {
  return publishDomainEvent(
    {
      groupId: guaranteedRentContract.groupId,
      companyId: guaranteedRentContract.companyId,
      aggregateType: 'GuaranteedRentContract',
      aggregateId: guaranteedRentContract.id,
      eventType: 'guaranteed_rent.paid',
      payload: { id: guaranteedRentContract.id, contractId: guaranteedRentContract.contractId, period },
      idempotencyKey: `guaranteed_rent.paid:${guaranteedRentContract.id}:${period}`,
    },
    transaction
  );
}

function publishAdvanceCompleted(rentAdvance, transaction) {
  return publishDomainEvent(
    {
      groupId: rentAdvance.groupId,
      companyId: rentAdvance.companyId,
      aggregateType: 'RentAdvance',
      aggregateId: rentAdvance.id,
      eventType: 'advance.completed',
      payload: { id: rentAdvance.id, contractId: rentAdvance.contractId, principalAmount: rentAdvance.principalAmount, costAmount: rentAdvance.costAmount },
      idempotencyKey: `advance.completed:${rentAdvance.id}`,
    },
    transaction
  );
}

function publishUtilityTransferRequired(ownershipTransferTask, transaction) {
  return publishDomainEvent(
    {
      groupId: ownershipTransferTask.groupId,
      companyId: ownershipTransferTask.companyId,
      aggregateType: 'OwnershipTransferTask',
      aggregateId: ownershipTransferTask.id,
      eventType: 'utility.transfer.required',
      payload: { id: ownershipTransferTask.id, utilityObligationId: ownershipTransferTask.utilityObligationId },
      idempotencyKey: `utility.transfer.required:${ownershipTransferTask.id}`,
    },
    transaction
  );
}

function publishUtilityTransferCompleted(ownershipTransferTask, transaction) {
  return publishDomainEvent(
    {
      groupId: ownershipTransferTask.groupId,
      companyId: ownershipTransferTask.companyId,
      aggregateType: 'OwnershipTransferTask',
      aggregateId: ownershipTransferTask.id,
      eventType: 'utility.transfer.completed',
      payload: { id: ownershipTransferTask.id, utilityObligationId: ownershipTransferTask.utilityObligationId },
      idempotencyKey: `utility.transfer.completed:${ownershipTransferTask.id}`,
    },
    transaction
  );
}

function publishReimbursementCreated(utilityReimbursement, transaction) {
  return publishDomainEvent(
    {
      groupId: utilityReimbursement.groupId,
      companyId: utilityReimbursement.companyId,
      aggregateType: 'UtilityReimbursement',
      aggregateId: utilityReimbursement.id,
      eventType: 'reimbursement.created',
      payload: {
        id: utilityReimbursement.id,
        utilityObligationId: utilityReimbursement.utilityObligationId,
        amount: utilityReimbursement.amount,
        owedByParty: utilityReimbursement.owedByParty,
      },
      idempotencyKey: `reimbursement.created:${utilityReimbursement.id}`,
    },
    transaction
  );
}

function publishCloseoutBlocked(contract, pendingReasons, transaction) {
  return publishDomainEvent(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      aggregateType: 'Contract',
      aggregateId: contract.id,
      eventType: 'closeout.blocked',
      payload: { id: contract.id, pendingReasons },
      idempotencyKey: `closeout.blocked:${contract.id}:${Date.now()}`,
    },
    transaction
  );
}

function publishCloseoutCompleted(contract, transaction) {
  return publishDomainEvent(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      aggregateType: 'Contract',
      aggregateId: contract.id,
      eventType: 'closeout.completed',
      payload: { id: contract.id },
      idempotencyKey: `closeout.completed:${contract.id}`,
    },
    transaction
  );
}

module.exports = {
  publishBillingGenerated,
  publishRentAdjusted,
  publishChargeOverdue,
  publishGuaranteedRentPaid,
  publishAdvanceCompleted,
  publishUtilityTransferRequired,
  publishUtilityTransferCompleted,
  publishReimbursementCreated,
  publishCloseoutBlocked,
  publishCloseoutCompleted,
};
