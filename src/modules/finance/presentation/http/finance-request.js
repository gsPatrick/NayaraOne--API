'use strict';

/** Montagem do pedido para os serviços do Financeiro a partir da requisição HTTP (Guia M4 §2 presentation/http). */
function withTenant(req) {
  return { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
}

// F03 — baixa manual de pagamento bancário (exceção formal): comprovante + motivo vêm do corpo.
function manualSettlementFromBody(body) {
  if (!body || (!body.settlementEvidenceFileId && !body.settlementReason)) return null;
  return { evidenceFileId: body.settlementEvidenceFileId, reason: body.settlementReason };
}

module.exports = { withTenant, manualSettlementFromBody };
