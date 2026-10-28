'use strict';

const { dueFromDateValue } = require('./time');
const { projectWarrantySourceId } = require('./ids');
const { clipTitle, emptyResult, transition, itemDraft } = require('./draft');

/**
 * Fonte GUARANTEE do calendário (M9-D803 §3.2 e §3.2.1): fiança/caução do contrato (LEGAL_GUARANTEE), caso em garantia de
 * obra (WARRANTY_CASE) e garantia da obra entregue (PROJECT_WARRANTY). Funções puras, sem leitura de banco.
 */
const SOURCE = 'GUARANTEE';
const guaranteeLink = (contractId) => `/painel/juridico/contratos/${contractId}`;
const caseLink = (caseId) => `/painel/obras/pos-obra/${caseId}`;
const projectLink = (projectId) => `/painel/obras/${projectId}`;

/** data: { id, contractId, guaranteeType, contractNumber, endsAt, status, ownerUserId }; só garantia ACTIVE com fim vira item. */
function legalGuaranteeResult(data, ctx) {
  const out = emptyResult();
  if (data.status === 'RELEASED') { out.transitions.push(transition(SOURCE, data.id, 'DONE')); return out; }
  if (data.status === 'CANCELLED') { out.transitions.push(transition(SOURCE, data.id, 'CANCELLED', 'SOURCE_CANCELLED')); return out; }
  const dueAt = dueFromDateValue(data.endsAt);
  if (!dueAt) { out.transitions.push(transition(SOURCE, data.id, 'CANCELLED', 'NO_DUE_DATE')); return out; }
  out.items.push(itemDraft(ctx, {
    sourceType: SOURCE,
    sourceId: data.id,
    sourceKind: 'LEGAL_GUARANTEE',
    title: clipTitle(`Fim da garantia ${data.guaranteeType || ''} do contrato ${data.contractNumber || data.contractId || ''}`, 'Fim da garantia do contrato'),
    ownerUserId: data.ownerUserId || null,
    dueAt,
    deepLink: guaranteeLink(data.contractId),
  }));
  return out;
}

/** data: { id, description, warrantyDeadlineAt, responsibleUserId, severity? }; prazo é um instante completo (sem fim de dia). */
function warrantyCaseResult(data, ctx) {
  const out = emptyResult();
  const dueAt = dueFromDateValue(data.warrantyDeadlineAt, { dateOnly: false });
  if (!dueAt) { out.transitions.push(transition(SOURCE, data.id, 'CANCELLED', 'NO_DUE_DATE')); return out; }
  out.items.push(itemDraft(ctx, {
    sourceType: SOURCE,
    sourceId: data.id,
    sourceKind: 'WARRANTY_CASE',
    title: clipTitle(`Prazo de garantia do chamado: ${data.description || ''}`, 'Prazo de garantia do chamado'),
    ownerUserId: data.responsibleUserId || null,
    dueAt,
    deepLink: caseLink(data.id),
    ...(data.severity ? { severity: data.severity } : {}),
    ...(data.preserveStatus ? { preserveStatus: true } : {}),
  }));
  return out;
}

/** data: { projectId, name, warrantyEndsAt, responsibleUserId }; source_id é o uuid v5 de (obra, WARRANTY). */
function projectWarrantyResult(data, ctx) {
  const out = emptyResult();
  const sourceId = projectWarrantySourceId(data.projectId);
  const dueAt = dueFromDateValue(data.warrantyEndsAt);
  if (!dueAt) { out.transitions.push(transition(SOURCE, sourceId, 'CANCELLED', 'NO_DUE_DATE')); return out; }
  out.items.push(itemDraft(ctx, {
    sourceType: SOURCE,
    sourceId,
    sourceKind: 'PROJECT_WARRANTY',
    title: clipTitle(`Fim da garantia da obra ${data.name || ''}`, 'Fim da garantia da obra'),
    ownerUserId: data.responsibleUserId || null,
    dueAt,
    deepLink: projectLink(data.projectId),
  }));
  return out;
}

const guaranteeData = (p) => ({
  id: p.id, contractId: p.contractId, guaranteeType: p.guaranteeType, contractNumber: p.contractNumber,
  endsAt: p.endsAt, status: p.status, ownerUserId: p.ownerUserId,
});

const EVENT_MAPPERS = {
  'legal.guarantee.created': (p, ctx) => legalGuaranteeResult(guaranteeData(p), ctx),
  'legal.guarantee.updated': (p, ctx) => legalGuaranteeResult(guaranteeData(p), ctx),
  // Substituição: fecha a antiga (DONE) e abre a nova (a nova também nasce pelo seu próprio legal.guarantee.created).
  'legal.guarantee.replaced': (p, ctx) => {
    const out = p.newGuarantee ? legalGuaranteeResult(guaranteeData(p.newGuarantee), ctx) : emptyResult();
    out.transitions.unshift(transition(SOURCE, p.id, 'DONE'));
    return out;
  },
  'legal.guarantee.ended': (p) => {
    const out = emptyResult();
    const cancelled = p.reason === 'DELETED' || p.reason === 'CANCELLED';
    out.transitions.push(cancelled ? transition(SOURCE, p.id, 'CANCELLED', p.reason === 'DELETED' ? 'SOURCE_DELETED' : 'SOURCE_CANCELLED') : transition(SOURCE, p.id, 'DONE'));
    return out;
  },
  'warranty.case.opened': (p, ctx) => warrantyCaseResult(p, ctx),
  // Escalonamento: só sobe a severidade para CRITICAL; prazo e status não mudam (preserveStatus: o projetor não reabre item fechado).
  'warranty.case.escalated': (p, ctx) => warrantyCaseResult({ ...p, severity: 'CRITICAL', preserveStatus: true }, ctx),
  'warranty.case.closed': (p) => {
    const out = emptyResult();
    out.transitions.push(transition(SOURCE, p.id, 'DONE'));
    return out;
  },
  'project.warranty_started': (p, ctx) => projectWarrantyResult({ projectId: p.id, name: p.name, warrantyEndsAt: p.warrantyEndsAt, responsibleUserId: p.responsibleUserId }, ctx),
};

module.exports = { legalGuaranteeResult, warrantyCaseResult, projectWarrantyResult, EVENT_MAPPERS };
