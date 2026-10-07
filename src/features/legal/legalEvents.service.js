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
      // FIX (relatado pela Nayara em reteste, 01/10/2026 — mesma causa raiz já achada e
      // corrigida no módulo de Obras): a chave antiga não incluía nada que distinguisse duas
      // ocorrências LEGÍTIMAS da mesma transição no mesmo contrato (ex.: contrato volta de
      // "Em assinatura" pra um status anterior por algum motivo, e depois tenta ir pra "Em
      // assinatura" de novo). A segunda ocorrência colidia com o índice único de
      // idempotencyKey da outbox, estourando UNIQUE_CONSTRAINT_VIOLATION (409 cru) e
      // revertendo a transação inteira. lockVersion incrementa a cada save() e já reflete o
      // valor pós-save neste ponto, tornando cada save real uma chave distinta.
      idempotencyKey: `legal.contract.status_changed:${contract.id}:${fromStatus}:${contract.status}:${contract.lockVersion}`,
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

// Caderno Anexo I "18. Eventos mínimos" / "9. Garantias locatícias": "lease.guarantee.expiring" —
// "Garantia vencendo gera tarefas/eventos". Disparado por legalGuaranteeExpiryAlertJob.js, uma
// vez por "rodada em que a severidade muda" (ver idempotencyKey abaixo) — mesmo padrão de
// publishLegalDeadlineAlert.
function publishGuaranteeExpiring(guarantee, daysUntilExpiry, transaction) {
  return publishDomainEvent(
    {
      groupId: guarantee.groupId,
      companyId: guarantee.companyId,
      aggregateType: 'Guarantee',
      aggregateId: guarantee.id,
      eventType: 'lease.guarantee.expiring',
      payload: { id: guarantee.id, contractId: guarantee.contractId, guaranteeType: guarantee.guaranteeType, endsAt: guarantee.endsAt, daysUntilExpiry },
      // idempotencyKey inclui o dia corrido (YYYY-MM-DD) do disparo: alerta no máximo uma vez
      // por dia por garantia, sem silenciar renovações de alerta em dias seguintes enquanto a
      // garantia continuar vencendo/vencida e sem destravar.
      idempotencyKey: `lease.guarantee.expiring:${guarantee.id}:${new Date().toISOString().slice(0, 10)}`,
    },
    transaction
  );
}

function publishGuaranteeReplaced(oldGuarantee, newGuarantee, transaction) {
  return publishDomainEvent(
    {
      groupId: oldGuarantee.groupId,
      companyId: oldGuarantee.companyId,
      aggregateType: 'Guarantee',
      aggregateId: oldGuarantee.id,
      eventType: 'legal.guarantee.replaced',
      payload: { id: oldGuarantee.id, contractId: oldGuarantee.contractId, replacedByGuaranteeId: newGuarantee.id },
      idempotencyKey: `legal.guarantee.replaced:${oldGuarantee.id}:${newGuarantee.id}`,
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

// Caderno Anexo I "10. Entrega de chaves" / "18. Eventos mínimos": "Evento keys.delivered inicia
// pós-chaves/cadências e obrigações." Mantido como evento DISTINTO de
// "legal.key_delivery.released" (que já existia e pode ter consumidores próprios) — o nome
// exato citado no Caderno é publicado também, para que o Motor de Regras de pós-chaves
// (cadências/obrigações locatícias) tenha o gatilho com o nome literal esperado.
function publishKeysDelivered(keyDelivery, transaction) {
  return publishDomainEvent(
    {
      groupId: keyDelivery.groupId,
      companyId: keyDelivery.companyId,
      aggregateType: 'KeyDelivery',
      aggregateId: keyDelivery.id,
      eventType: 'keys.delivered',
      payload: { id: keyDelivery.id, contractId: keyDelivery.contractId, deliveredToPersonId: keyDelivery.deliveredToPersonId },
      idempotencyKey: `keys.delivered:${keyDelivery.id}`,
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

function publishLegalDeadlineAlert(deadline, severity, transaction) {
  return publishDomainEvent(
    {
      groupId: deadline.groupId,
      companyId: deadline.companyId,
      aggregateType: 'LegalDeadline',
      aggregateId: deadline.id,
      eventType: 'legal.deadline.alert',
      payload: { id: deadline.id, legalCaseId: deadline.legalCaseId, description: deadline.description, dueAt: deadline.dueAt, severity },
      // idempotencyKey inclui a severidade: um prazo que já alertou DUE_SOON precisa poder
      // alertar de novo quando vira OVERDUE (é um evento genuinamente novo), mas nunca duas
      // vezes pra MESMA severidade do MESMO prazo.
      idempotencyKey: `legal.deadline.alert:${deadline.id}:${severity}`,
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
  publishGuaranteeExpiring,
  publishGuaranteeReplaced,
  publishInspectionCompleted,
  publishKeyDeliveryReleased,
  publishKeysDelivered,
  publishLegalCaseCreated,
  publishLegalDeadlineAlert,
  publishEvidencePackageCreated,
};
