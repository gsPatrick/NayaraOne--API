'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');

// Publicação dos domain events do módulo correspondent (Transactional Outbox), seguindo o mesmo
// padrão de src/features/legal/legalEvents.service.js / src/features/finance/financeEvents.service.js
// — sempre dentro da MESMA transação da operação de negócio que originou o evento.

/**
 * publishSubmissionRequested — "financing.submission_requested" (Caderno, Fase 5: "Persistir
 * snapshotHash e PENDING; emitir financing.submission_requested."). idempotencyKey reaproveita a
 * MESMA chave da submission (já é única por empresa) — uma submissão sempre gera exatamente um
 * evento, nunca duplica mesmo que o service seja chamado de novo com a mesma key (o service já
 * retorna a submission existente nesse caso, sem recriar o evento).
 */
function publishSubmissionRequested(submission, transaction) {
  return publishDomainEvent(
    {
      groupId: submission.groupId,
      companyId: submission.companyId,
      aggregateType: 'ProviderSubmission',
      aggregateId: submission.id,
      eventType: 'financing.submission_requested',
      payload: {
        id: submission.id,
        financingCaseId: submission.financingCaseId,
        providerCode: submission.providerCode,
        idempotencyKey: submission.idempotencyKey,
      },
      idempotencyKey: `financing.submission_requested:${submission.idempotencyKey}`,
    },
    transaction
  );
}

/**
 * publishAppraisalRequested / publishAppraisalCompleted — "appraisal.requested" /
 * "appraisal.completed" (Caderno, Fase 9: lista de eventos mínimos). idempotencyKey reaproveita
 * o id da appraisal + o evento, pra nunca duplicar mesmo se o service for chamado de novo.
 */
function publishAppraisalRequested(appraisal, transaction) {
  return publishDomainEvent(
    {
      groupId: appraisal.groupId,
      companyId: appraisal.companyId,
      aggregateType: 'Appraisal',
      aggregateId: appraisal.id,
      eventType: 'appraisal.requested',
      payload: {
        id: appraisal.id,
        financingCaseId: appraisal.financingCaseId,
        providerCode: appraisal.providerCode,
      },
      idempotencyKey: `appraisal.requested:${appraisal.id}`,
    },
    transaction
  );
}

function publishAppraisalCompleted(appraisal, transaction) {
  return publishDomainEvent(
    {
      groupId: appraisal.groupId,
      companyId: appraisal.companyId,
      aggregateType: 'Appraisal',
      aggregateId: appraisal.id,
      eventType: 'appraisal.completed',
      payload: {
        id: appraisal.id,
        financingCaseId: appraisal.financingCaseId,
        providerCode: appraisal.providerCode,
        requestedValue: appraisal.requestedValue,
      },
      idempotencyKey: `appraisal.completed:${appraisal.id}`,
    },
    transaction
  );
}

/**
 * publishCommissionEntitlementCreated / publishCommissionConfirmed — "commission.entitlement.created"
 * / "commission.confirmed" (Caderno, Fase 9: lista de eventos mínimos). idempotencyKey reaproveita
 * o id do entitlement + o evento, pra nunca duplicar mesmo se o service for chamado de novo.
 */
function publishCommissionEntitlementCreated(entitlement, transaction) {
  return publishDomainEvent(
    {
      groupId: entitlement.groupId,
      companyId: entitlement.companyId,
      aggregateType: 'CommissionEntitlement',
      aggregateId: entitlement.id,
      eventType: 'commission.entitlement.created',
      payload: {
        id: entitlement.id,
        financingCaseId: entitlement.financingCaseId,
        amount: entitlement.amount,
      },
      idempotencyKey: `commission.entitlement.created:${entitlement.id}`,
    },
    transaction
  );
}

function publishCommissionConfirmed(entitlement, transaction) {
  return publishDomainEvent(
    {
      groupId: entitlement.groupId,
      companyId: entitlement.companyId,
      aggregateType: 'CommissionEntitlement',
      aggregateId: entitlement.id,
      eventType: 'commission.confirmed',
      payload: {
        id: entitlement.id,
        financingCaseId: entitlement.financingCaseId,
        amount: entitlement.amount,
        financialEntryId: entitlement.financialEntryId,
      },
      idempotencyKey: `commission.confirmed:${entitlement.id}`,
    },
    transaction
  );
}

module.exports = {
  publishSubmissionRequested,
  publishAppraisalRequested,
  publishAppraisalCompleted,
  publishCommissionEntitlementCreated,
  publishCommissionConfirmed,
};
