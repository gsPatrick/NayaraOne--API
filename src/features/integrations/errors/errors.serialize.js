'use strict';

/** Visão pública de um erro de integração (já sanitizado; nunca carrega segredo, PII ou corpo bruto). */
function serializeError(e) {
  return {
    id: e.id,
    connectionId: e.connectionId,
    providerCode: e.providerCode,
    source: e.source,
    sourceRefId: e.financingCaseId,
    operation: e.operation,
    errorClass: e.errorClass,
    errorCode: e.errorCode,
    severity: e.severity,
    message: e.message,
    sanitizedPayload: e.sanitizedPayload,
    payloadHash: e.payloadHash,
    httpStatus: e.httpStatus,
    attempts: e.attempts,
    status: e.status,
    resolvedBy: e.resolvedBy,
    resolvedAt: e.resolvedAt,
    resolutionNote: e.resolutionNote,
    correlationId: e.correlationId,
    createdAt: e.created_at,
  };
}

module.exports = { serializeError };
