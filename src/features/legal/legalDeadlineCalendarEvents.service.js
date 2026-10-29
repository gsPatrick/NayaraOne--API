'use strict';

const { publishSourceEvent } = require('../core-governance/calendar/calendar.publisher');

/**
 * Eventos de prazo jurídico e de renovação de contrato que alimentam o Calendário unificado (M9-D802 §3.1.1). Na transação da
 * operação. O `legal.deadline.created` continua em legalEvents.service.js (agora com descrição e responsável no payload).
 */
const CANCELLED = ['CANCELED', 'CANCELLED'];

function deadlinePayload(deadline) {
  return { legalCaseId: deadline.legalCaseId, description: deadline.description, dueAt: deadline.dueAt, responsibleUserId: deadline.responsibleUserId || null, status: deadline.status };
}

/** Depois de salvar uma alteração do prazo: concluído, cancelado, reaberto ou apenas alterado (vencimento, responsável, descrição). */
function publishDeadlineChange(deadline, beforeStatus, transaction) {
  let eventType = 'legal.deadline.updated';
  if (deadline.status === 'DONE' && beforeStatus !== 'DONE') eventType = 'legal.deadline.completed';
  else if (CANCELLED.includes(deadline.status) && !CANCELLED.includes(beforeStatus)) eventType = 'legal.deadline.cancelled';
  else if (deadline.status === 'PENDING' && beforeStatus !== 'PENDING') eventType = 'legal.deadline.reopened';
  return publishSourceEvent({ entity: deadline, aggregateType: 'LegalDeadline', eventType, payload: deadlinePayload(deadline) }, transaction);
}

const RENEWAL_LIVE = ['SIGNED', 'ACTIVE', 'SUSPENDED'];

/**
 * Renovação do contrato (data de término `ends_at`). Contrato assinado, ativo ou suspenso com término vira/atualiza o item
 * (`contract.renewal.upserted`); encerrado (CLOSED) conclui; rescindido ou cancelado cancela. Rascunho e sem término: nada a publicar.
 */
function publishContractRenewalChange(contract, transaction) {
  const payload = { contractNumber: contract.contractNumber, endsAt: contract.endsAt || null, ownerUserId: contract.updatedBy || contract.createdBy || null, status: contract.status };
  let eventType = null;
  if (contract.status === 'CLOSED') eventType = 'contract.renewal.completed';
  else if (['TERMINATED', 'CANCELLED', 'CANCELED'].includes(contract.status)) eventType = 'contract.renewal.cancelled';
  else if (RENEWAL_LIVE.includes(contract.status) && contract.endsAt) eventType = 'contract.renewal.upserted';
  if (!eventType) return null;
  return publishSourceEvent({ entity: contract, aggregateType: 'Contract', eventType, payload }, transaction);
}

module.exports = { publishDeadlineChange, publishContractRenewalChange };
