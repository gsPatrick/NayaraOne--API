'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');

// Publicação dos domain events do módulo legal (Transactional Outbox), seguindo o mesmo
// padrão de src/features/finance/financeEvents.service.js — sempre dentro da MESMA
// transação da operação de negócio.

function publishContractStatusChanged(contract, fromStatus, transaction) {
  return publishDomainEvent(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      aggregateType: 'Contract',
      aggregateId: contract.id,
      eventType: 'legal.contract.status_changed',
      payload: { id: contract.id, fromStatus, toStatus: contract.status },
      idempotencyKey: `legal.contract.status_changed:${contract.id}:${fromStatus}:${contract.status}`,
    },
    transaction
  );
}

function publishContractVersionCreated(contractVersion, transaction) {
  return publishDomainEvent(
    {
      groupId: contractVersion.groupId,
      companyId: contractVersion.companyId,
      aggregateType: 'ContractVersion',
      aggregateId: contractVersion.id,
      eventType: 'legal.contract_version.created',
      payload: { id: contractVersion.id, contractId: contractVersion.contractId, versionNumber: contractVersion.versionNumber },
      idempotencyKey: `legal.contract_version.created:${contractVersion.id}`,
    },
    transaction
  );
}

function publishSignatureRequested(signature, transaction) {
  return publishDomainEvent(
    {
      groupId: signature.groupId,
      companyId: signature.companyId,
      aggregateType: 'Signature',
      aggregateId: signature.id,
      eventType: 'legal.signature.requested',
      payload: { id: signature.id, contractVersionId: signature.contractVersionId, personId: signature.personId },
      idempotencyKey: `legal.signature.requested:${signature.id}`,
    },
    transaction
  );
}

function publishSignatureSigned(signature, transaction) {
  return publishDomainEvent(
    {
      groupId: signature.groupId,
      companyId: signature.companyId,
      aggregateType: 'Signature',
      aggregateId: signature.id,
      eventType: 'legal.signature.signed',
      payload: { id: signature.id, contractVersionId: signature.contractVersionId, personId: signature.personId },
      idempotencyKey: `legal.signature.signed:${signature.id}`,
    },
    transaction
  );
}

function publishGuaranteeCreated(guarantee, transaction) {
  return publishDomainEvent(
    {
      groupId: guarantee.groupId,
      companyId: guarantee.companyId,
      aggregateType: 'Guarantee',
      aggregateId: guarantee.id,
      eventType: 'legal.guarantee.created',
      payload: { id: guarantee.id, contractId: guarantee.contractId, guaranteeType: guarantee.guaranteeType },
      idempotencyKey: `legal.guarantee.created:${guarantee.id}`,
    },
    transaction
  );
}

function publishInspectionCompleted(inspection, transaction) {
  return publishDomainEvent(
    {
      groupId: inspection.groupId,
      companyId: inspection.companyId,
      aggregateType: 'Inspection',
      aggregateId: inspection.id,
      eventType: 'legal.inspection.completed',
      payload: { id: inspection.id, propertyId: inspection.propertyId, inspectionType: inspection.inspectionType },
      idempotencyKey: `legal.inspection.completed:${inspection.id}`,
    },
    transaction
  );
}

function publishKeyDeliveryReleased(keyDelivery, transaction) {
  return publishDomainEvent(
    {
      groupId: keyDelivery.groupId,
      companyId: keyDelivery.companyId,
      aggregateType: 'KeyDelivery',
      aggregateId: keyDelivery.id,
      eventType: 'legal.key_delivery.released',
      payload: { id: keyDelivery.id, contractId: keyDelivery.contractId, deliveredToPersonId: keyDelivery.deliveredToPersonId },
      idempotencyKey: `legal.key_delivery.released:${keyDelivery.id}`,
    },
    transaction
  );
}

function publishLegalCaseCreated(legalCase, transaction) {
  return publishDomainEvent(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      aggregateType: 'LegalCase',
      aggregateId: legalCase.id,
      eventType: 'legal.case.created',
      payload: { id: legalCase.id, caseType: legalCase.caseType, contractId: legalCase.contractId },
      idempotencyKey: `legal.case.created:${legalCase.id}`,
    },
    transaction
  );
}

function publishEvidencePackageCreated(evidencePackage, transaction) {
  return publishDomainEvent(
    {
      groupId: evidencePackage.groupId,
      companyId: evidencePackage.companyId,
      aggregateType: 'EvidencePackage',
      aggregateId: evidencePackage.id,
      eventType: 'legal.evidence_package.created',
      payload: { id: evidencePackage.id, legalCaseId: evidencePackage.legalCaseId, packageHash: evidencePackage.packageHash },
      idempotencyKey: `legal.evidence_package.created:${evidencePackage.id}`,
    },
    transaction
  );
}

module.exports = {
  publishContractStatusChanged,
  publishContractVersionCreated,
  publishSignatureRequested,
  publishSignatureSigned,
  publishGuaranteeCreated,
  publishInspectionCompleted,
  publishKeyDeliveryReleased,
  publishLegalCaseCreated,
  publishEvidencePackageCreated,
};
