'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');
const { OutboxEvent } = require('../../models');

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

/**
 * publishFinancingCaseCreated — "financing.case.created" (Caderno, Fase 9: lista de eventos
 * mínimos). Emitido uma vez, na criação do case.
 */
function publishFinancingCaseCreated(financingCase, transaction) {
  return publishDomainEvent(
    {
      groupId: financingCase.groupId,
      companyId: financingCase.companyId,
      aggregateType: 'FinancingCase',
      aggregateId: financingCase.id,
      eventType: 'financing.case.created',
      payload: {
        id: financingCase.id,
        providerCode: financingCase.providerCode,
        purpose: financingCase.purpose,
        propertyId: financingCase.propertyId,
      },
      idempotencyKey: `financing.case.created:${financingCase.id}`,
    },
    transaction
  );
}

/**
 * publishFinancingDocumentsCompleted — "financing.documents.completed". Emitido quando TODOS os
 * requirements obrigatórios do case saem de PENDING (pelo menos SUBMITTED) — chamado pelo
 * service de documentos depois de cada upload, sempre que o checklist estiver 100% completo.
 * `idempotencyKey` é fixa por case (nunca inclui o documento que disparou a checagem), então
 * chamadas repetidas em uploads futuros (checklist já estava completo antes) colidiriam com a
 * UNIQUE da key — checamos a existência ANTES de tentar o INSERT (nunca via catch de
 * UniqueConstraintError: um erro de banco dentro da transação em andamento a deixaria abortada
 * para qualquer comando seguinte, inclusive o commit do upload que disparou esta checagem).
 */
async function publishFinancingDocumentsCompleted(financingCase, transaction) {
  const idempotencyKey = `financing.documents.completed:${financingCase.id}`;
  const already = await OutboxEvent.findOne({ where: { idempotencyKey }, transaction });
  if (already) return already;
  return publishDomainEvent(
    {
      groupId: financingCase.groupId,
      companyId: financingCase.companyId,
      aggregateType: 'FinancingCase',
      aggregateId: financingCase.id,
      eventType: 'financing.documents.completed',
      payload: { id: financingCase.id },
      idempotencyKey,
    },
    transaction
  );
}

/**
 * publishFinancingSubmitted — "financing.submitted". Emitido quando a submissão ao provider tem
 * sucesso (distinto de "financing.submission_requested", que marca só a intenção/PENDING).
 */
function publishFinancingSubmitted(financingCase, submission, transaction) {
  return publishDomainEvent(
    {
      groupId: financingCase.groupId,
      companyId: financingCase.companyId,
      aggregateType: 'FinancingCase',
      aggregateId: financingCase.id,
      eventType: 'financing.submitted',
      payload: {
        id: financingCase.id,
        providerCode: financingCase.providerCode,
        externalCaseId: submission.externalCaseId,
      },
      idempotencyKey: `financing.submitted:${submission.id}`,
    },
    transaction
  );
}

const TERMINAL_EVENT_BY_STATUS = {
  APPROVED: 'financing.approved',
  REJECTED: 'financing.rejected',
  COMPLETED: 'financing.completed',
};

/**
 * publishFinancingStatusChanged — "financing.status.changed", e adicionalmente
 * "financing.approved"/"financing.rejected"/"financing.completed" quando o novo status for um
 * desses três (Caderno: eventos mínimos separados para os status terminais relevantes, além do
 * genérico de mudança). `occurredAt` entra na idempotencyKey porque o mesmo case pode passar
 * pelo mesmo `normalizedStatus` mais de uma vez de forma legítima ao longo da vida do caso (ex:
 * webhooks fora de ordem já tratados por `shouldApplyTransition`), então a key não pode ser só
 * `financingCaseId:status`.
 */
async function publishFinancingStatusChanged(financingCase, { previousStatus, normalizedStatus, historyId }, transaction) {
  await publishDomainEvent(
    {
      groupId: financingCase.groupId,
      companyId: financingCase.companyId,
      aggregateType: 'FinancingCase',
      aggregateId: financingCase.id,
      eventType: 'financing.status.changed',
      payload: { id: financingCase.id, previousStatus, status: normalizedStatus },
      idempotencyKey: `financing.status.changed:${historyId}`,
    },
    transaction
  );

  const terminalEventType = TERMINAL_EVENT_BY_STATUS[normalizedStatus];
  if (terminalEventType) {
    await publishDomainEvent(
      {
        groupId: financingCase.groupId,
        companyId: financingCase.companyId,
        aggregateType: 'FinancingCase',
        aggregateId: financingCase.id,
        eventType: terminalEventType,
        payload: { id: financingCase.id, status: normalizedStatus },
        idempotencyKey: `${terminalEventType}:${historyId}`,
      },
      transaction
    );
  }
}

/**
 * publishIntegrationCorrespondentFailed — "integration.correspondent.failed". Emitido quando o
 * adapter falha de forma não recuperável (submissão vira UNKNOWN) — nunca inclui o corpo cru da
 * exceção (só a mensagem de negócio já sanitizada que o service monta), pra nunca vazar detalhe
 * técnico de infraestrutura no payload do evento.
 */
function publishIntegrationCorrespondentFailed(financingCase, { providerCode, reason, submissionId }, transaction) {
  return publishDomainEvent(
    {
      groupId: financingCase.groupId,
      companyId: financingCase.companyId,
      aggregateType: 'FinancingCase',
      aggregateId: financingCase.id,
      eventType: 'integration.correspondent.failed',
      payload: { id: financingCase.id, providerCode, reason },
      idempotencyKey: `integration.correspondent.failed:${submissionId}`,
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
  publishFinancingCaseCreated,
  publishFinancingDocumentsCompleted,
  publishFinancingSubmitted,
  publishFinancingStatusChanged,
  publishIntegrationCorrespondentFailed,
};
