'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');

/**
 * Eventos de garantia locatícia que alimentam o Calendário unificado (M9-D803). Separado de legalEvents.service.js (uma
 * responsabilidade por arquivo); sempre na transação da operação (Transactional Outbox).
 */

/** Campos da garantia que o calendário precisa (fim, situação, dono e número do contrato). `contract` é opcional. */
function guaranteeCalendarFields(guarantee, contract) {
  return {
    endsAt: guarantee.endsAt || null,
    status: guarantee.status,
    ownerUserId: (contract && contract.createdBy) || guarantee.createdBy || null,
    contractNumber: (contract && contract.contractNumber) || null,
  };
}

/** legal.guarantee.updated — mudança de ends_at ou status. Chave `legal.guarantee.updated:<id>:<lock_version>`. */
function publishGuaranteeUpdated(guarantee, contract, transaction) {
  return publishDomainEvent(
    {
      groupId: guarantee.groupId,
      companyId: guarantee.companyId,
      aggregateType: 'Guarantee',
      aggregateId: guarantee.id,
      eventType: 'legal.guarantee.updated',
      payload: { id: guarantee.id, contractId: guarantee.contractId, guaranteeType: guarantee.guaranteeType, ...guaranteeCalendarFields(guarantee, contract) },
      idempotencyKey: `legal.guarantee.updated:${guarantee.id}:${guarantee.lockVersion}`,
    },
    transaction
  );
}

/** legal.guarantee.ended — encerramento (liberada, cancelada ou excluída). Chave `legal.guarantee.ended:<id>`. */
function publishGuaranteeEnded(guarantee, reason, transaction) {
  return publishDomainEvent(
    {
      groupId: guarantee.groupId,
      companyId: guarantee.companyId,
      aggregateType: 'Guarantee',
      aggregateId: guarantee.id,
      eventType: 'legal.guarantee.ended',
      payload: { id: guarantee.id, contractId: guarantee.contractId, status: guarantee.status, reason },
      idempotencyKey: `legal.guarantee.ended:${guarantee.id}`,
    },
    transaction
  );
}

module.exports = { guaranteeCalendarFields, publishGuaranteeUpdated, publishGuaranteeEnded };
