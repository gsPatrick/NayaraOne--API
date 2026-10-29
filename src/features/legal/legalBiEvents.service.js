'use strict';

/**
 * M9-D619 — eventos do Jurídico que atualizam os read models do BI (processos por risco, valores e documentos faltantes), publicados na MESMA
 * transação da mudança (Transactional Outbox). Só ids e estado, nunca parte, teor ou advogado.
 *  - legal.case.updated: o processo mudou de status, fase, risco, valor estimado ou valor confirmado.
 *  - legal.contract_requirement.updated: uma exigência de documento do contrato foi gerada, atendida ou dispensada.
 * A chave de idempotência inclui o instante da gravação: a mesma exigência muda de estado mais de uma vez ao longo da vida.
 */
const { publishDomainEvent } = require('../../engines/events/outbox');

const stampOf = (entity) => new Date(entity.updatedAt || entity.updated_at || Date.now()).getTime();

function publishLegalCaseUpdated(legalCase, transaction) {
  return publishDomainEvent(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      aggregateType: 'LegalCase',
      aggregateId: legalCase.id,
      eventType: 'legal.case.updated',
      payload: { id: legalCase.id, caseType: legalCase.caseType, status: legalCase.status, phase: legalCase.phase || null, riskLevel: legalCase.riskLevel || null },
      idempotencyKey: `legal.case.updated:${legalCase.id}:${legalCase.lockVersion}:${stampOf(legalCase)}`,
    },
    transaction
  );
}

function publishContractRequirementUpdated(requirement, transaction) {
  return publishDomainEvent(
    {
      groupId: requirement.groupId,
      companyId: requirement.companyId,
      aggregateType: 'ContractRequirement',
      aggregateId: requirement.id,
      eventType: 'legal.contract_requirement.updated',
      payload: { id: requirement.id, contractId: requirement.contractId, requirementType: requirement.requirementType, status: requirement.status },
      idempotencyKey: `legal.contract_requirement.updated:${requirement.id}:${requirement.status}:${stampOf(requirement)}`,
    },
    transaction
  );
}

module.exports = { publishLegalCaseUpdated, publishContractRequirementUpdated };
