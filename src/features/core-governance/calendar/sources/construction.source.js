'use strict';

const { CANCEL } = require('./sources.constants');
const { dueFromDateValue } = require('./time');
const { clipTitle, emptyResult, transition, itemDraft } = require('./draft');

/**
 * Fonte CONSTRUCTION do calendário (M9-D803 §3.1): etapa de obra (project_stages.ends_at) e prazo final da obra
 * (projects.ends_at_planned). Funções puras: recebem o dado da origem (evento ou linha da carga inicial) e devolvem o item
 * a gravar ou o fechamento; quem grava é o projetor (M9-D802) ou a carga inicial. Nada aqui lê banco.
 */
const SOURCE = 'CONSTRUCTION';
const PROJECT_DONE = new Set(['DELIVERED', 'WARRANTY', 'CLOSED']);

const stageLink = (projectId, stageId) => `/painel/obras/${projectId}/etapas/${stageId}`;
const projectLink = (projectId) => `/painel/obras/${projectId}`;

/** data: { stageId, projectId, projectName, stageName, endsAt, status, responsibleUserId }. */
function stageResult(data, ctx) {
  const out = emptyResult();
  if (data.status === 'DONE') { out.transitions.push(transition(SOURCE, data.stageId, 'DONE')); return out; }
  if (data.status === 'CANCELLED') { out.transitions.push(transition(SOURCE, data.stageId, 'CANCELLED', CANCEL.SOURCE_CANCELLED)); return out; }
  const dueAt = dueFromDateValue(data.endsAt, { dateOnly: false });
  if (!dueAt) { out.transitions.push(transition(SOURCE, data.stageId, 'CANCELLED', CANCEL.NO_DUE_DATE)); return out; }
  out.items.push(itemDraft(ctx, {
    sourceType: SOURCE,
    sourceId: data.stageId,
    sourceKind: 'STAGE',
    title: clipTitle(`Etapa ${data.stageName || ''} — obra ${data.projectName || ''}`, 'Etapa de obra'),
    ownerUserId: data.responsibleUserId || null,
    dueAt,
    deepLink: stageLink(data.projectId, data.stageId),
  }));
  return out;
}

/** data: { projectId, name, endsAtPlanned, status, responsibleUserId }; prazo da obra vence às 23:59:59 de Brasília. */
function projectResult(data, ctx) {
  const out = emptyResult();
  if (data.status === 'CANCELLED') { out.transitions.push(transition(SOURCE, data.projectId, 'CANCELLED', CANCEL.SOURCE_CANCELLED)); return out; }
  if (PROJECT_DONE.has(data.status)) { out.transitions.push(transition(SOURCE, data.projectId, 'DONE')); return out; }
  const dueAt = dueFromDateValue(data.endsAtPlanned);
  if (!dueAt) { out.transitions.push(transition(SOURCE, data.projectId, 'CANCELLED', CANCEL.NO_DUE_DATE)); return out; }
  out.items.push(itemDraft(ctx, {
    sourceType: SOURCE,
    sourceId: data.projectId,
    sourceKind: 'PROJECT',
    title: clipTitle(`Prazo final da obra ${data.name || ''}`, 'Prazo final da obra'),
    ownerUserId: data.responsibleUserId || null,
    dueAt,
    deepLink: projectLink(data.projectId),
  }));
  return out;
}

const fromStageEvent = (p) => ({
  stageId: p.stageId || p.id, projectId: p.projectId, projectName: p.projectName, stageName: p.stageName || p.name,
  endsAt: p.endsAt, status: p.status, responsibleUserId: p.responsibleUserId,
});
const fromProjectEvent = (p) => ({
  projectId: p.projectId || p.id, name: p.name, endsAtPlanned: p.endsAtPlanned, status: p.status || p.toStatus,
  responsibleUserId: p.responsibleUserId,
});

/** Mapa evento -> resultado (eventos existentes do Marco 6 + os de M9-D803). */
const EVENT_MAPPERS = {
  'project.stage.updated': (p, ctx) => stageResult(fromStageEvent(p), ctx),
  'project.stage.completed': (p) => {
    const out = emptyResult();
    out.transitions.push(transition(SOURCE, p.id, 'DONE'));
    return out;
  },
  'project.created': (p, ctx) => projectResult(fromProjectEvent(p), ctx),
  'project.started': (p, ctx) => projectResult(fromProjectEvent({ ...p, status: p.status || 'ACTIVE' }), ctx),
  'construction.project.status_changed': (p, ctx) => projectResult(fromProjectEvent(p), ctx),
  'project.schedule.updated': (p, ctx) => projectResult(fromProjectEvent(p), ctx),
  'project.delivered': (p, ctx) => projectResult(fromProjectEvent({ ...p, status: 'DELIVERED' }), ctx),
  'project.closed': (p, ctx) => projectResult(fromProjectEvent({ ...p, status: 'CLOSED' }), ctx),
};

module.exports = { stageResult, projectResult, EVENT_MAPPERS, PROJECT_DONE };
