'use strict';

/**
 * M9-D709 (3.1) — as quatro filas de decisão do Centro de Comando, a métrica de cada uma e o mapa de eventos do worker. Os nomes de evento do livro são
 * lógicos; quando o módulo de origem publica o mesmo fato com outro nome, o mapa abaixo traduz (finance.approval_step.decided carrega o pedido em
 * `approvalRequestId`; ai.* carrega `recommendationId`) e o contrato do read model não muda. Evento ausente só atrasa a fila até a agenda de 15 minutos.
 */
const KINDS = Object.freeze({
  FIN_APPROVAL: { metricCode: 'fin.approvals_pending', sourceType: 'finance.approval_requests', events: ['finance.approval_request.created', 'finance.approval_request.decided', 'finance.approval_step.decided'], idFields: ['approvalRequestId', 'id'] },
  INV_ADJUSTMENT: { metricCode: 'inv.adjustments_pending', sourceType: 'inventory.adjustment_proposals', events: ['inventory.adjustment_proposal.created', 'inventory.adjustment_proposal.decided'], idFields: ['id', 'proposalId'] },
  RULE_APPROVAL: { metricCode: 'tec.rule_approvals_pending', sourceType: 'core.rule_approval_requests', events: ['rules.approval_request.created', 'rules.approval_request.decided'], idFields: ['id', 'approvalRequestId'] },
  NAY_PROPOSAL: { metricCode: 'ai.proposals_pending', sourceType: 'ai.ai_recommendations', events: ['ai.recommendation.created', 'ai.recommendation.accepted', 'ai.recommendation.rejected'], idFields: ['recommendationId', 'id'] },
});
const KIND_CODES = Object.freeze(Object.keys(KINDS));
const EVENT_TYPES = Object.freeze(KIND_CODES.flatMap((k) => KINDS[k].events));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** { kind, source_id } do evento, ou null quando o evento não é de uma fila ou não traz um id de fonte válido. */
function keyOfEvent(event) {
  const kind = KIND_CODES.find((k) => KINDS[k].events.includes(event.eventType));
  if (!kind) return null;
  const payload = event.payloadJson || event.payload || {};
  const id = KINDS[kind].idFields.map((f) => payload[f]).find((v) => typeof v === 'string' && UUID_RE.test(v));
  return id ? { kind, source_id: id } : null;
}

module.exports = { KINDS, KIND_CODES, EVENT_TYPES, keyOfEvent };
