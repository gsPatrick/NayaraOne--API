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

module.exports = { publishSubmissionRequested };
