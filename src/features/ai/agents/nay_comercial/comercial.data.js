'use strict';

// M9-D034 — fatos de uma oportunidade lidos dos serviços do CRM (sob o RLS da empresa) para o resumo, a próxima ação e a tool
// `crm.getOpportunity`. Datas e contagens de dias são calculadas aqui, pelo código; o modelo nunca calcula.
const { FinancingCase, CaseRequirement, Person, Proposal } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const opportunityService = require('../../../crm/opportunity.service');
const { getOpportunityTimeline } = require('../../../crm/opportunityTimeline.service');
const { daysBetween } = require('./comercial.format');

const CLOSED_STAGES = ['CLOSED_WON', 'CLOSED_LOST', 'WITHDRAWN'];
const OPEN_TASK = ['OPEN', 'IN_PROGRESS'];
const INCOMPLETE_DOCUMENT = ['PENDING', 'REJECTED', 'EXPIRED'];

const notFound = () => new AppError('Dado não encontrado.', 404, 'AI_CROSS_COMPANY_BLOCKED');
const timeOf = (d) => (d ? new Date(d).getTime() : null);

/** Oportunidade da empresa do ator (a RLS esconde a de outra empresa: 404 igual ao de inexistente, sem revelar existência). */
async function findOpportunity(opportunityId, transaction) {
  try {
    return await opportunityService.getOpportunity(opportunityId, transaction);
  } catch (err) {
    if (err && err.statusCode === 404) throw notFound();
    throw err;
  }
}

/** Documentos pendentes da oportunidade: exigências ainda abertas dos processos de financiamento ligados a ela. */
async function pendingDocuments(opportunityId, companyId, transaction) {
  const cases = await FinancingCase.findAll({ where: { opportunityId, companyId }, attributes: ['id'], transaction });
  if (!cases.length) return [];
  const rows = await CaseRequirement.findAll({
    where: { financingCaseId: cases.map((c) => c.id), companyId, status: INCOMPLETE_DOCUMENT }, order: [['documentType', 'ASC']], transaction,
  });
  return [...new Set(rows.map((r) => String(r.documentType)))];
}

/** Interações de contato: mensagens e visitas que já aconteceram (a visita futura ainda não é contato). */
function interactionsOf(timeline, nowMs) {
  return timeline
    .filter((i) => (i.type === 'MESSAGE') || (i.type === 'VISIT' && timeOf(i.occurredAt) <= nowMs && !['CANCELED', 'NO_SHOW'].includes(i.data.status)))
    .map((i) => ({
      type: i.type, occurredAt: new Date(i.occurredAt).toISOString(), channel: i.data.channel || null, direction: i.data.direction || null, status: i.data.status || null,
    }));
}

/** Propostas enviadas e ainda sem resposta do cliente (nenhuma interação recebida depois do envio). */
function proposalsOf(rows, interactions, now) {
  return rows.map((p) => {
    const sentAt = p.sentAt || p.createdAt || p.get('created_at');
    const answered = interactions.some((x) => x.direction === 'INBOUND' && timeOf(x.occurredAt) > timeOf(sentAt));
    return { id: p.id, value: p.value === null || p.value === undefined ? null : String(p.value), sentAt: new Date(sentAt).toISOString(), daysSinceSent: daysBetween(sentAt, now), unanswered: !answered };
  });
}

/**
 * Fatos da oportunidade em `now`. `lastInteractionAt` é a mais recente das interações; sem nenhuma, o contato conta desde a abertura da
 * oportunidade (`contactBase: 'CREATED'`). Encerrada (ganha, perdida ou desistência) não tem dias sem contato a cobrar.
 */
async function loadOpportunityFacts(opportunityId, transaction, { now = new Date(), companyId } = {}) {
  const opportunity = await findOpportunity(opportunityId, transaction);
  const tenantCompany = companyId || opportunity.companyId;
  const [person, timeline, documents, sentProposals] = await Promise.all([
    Person.findByPk(opportunity.personId, { transaction }),
    getOpportunityTimeline(opportunityId, transaction),
    pendingDocuments(opportunityId, tenantCompany, transaction),
    Proposal.findAll({ where: { opportunityId, status: 'SENT' }, order: [['created_at', 'ASC']], transaction }),
  ]);
  const interactions = interactionsOf(timeline, now.getTime());
  const last = interactions.length ? interactions[0].occurredAt : null;
  const openedAt = opportunity.createdAt || opportunity.get('created_at');
  const base = last || (openedAt ? new Date(openedAt).toISOString() : null);
  const stage = String(opportunity.stage || '');
  const closed = CLOSED_STAGES.includes(stage.toUpperCase());
  return {
    opportunityId: opportunity.id,
    personId: opportunity.personId,
    propertyId: opportunity.propertyId || null,
    customerName: person ? (person.preferredName || person.legalName) : null,
    stage,
    closed,
    expectedValue: opportunity.expectedValue === null || opportunity.expectedValue === undefined ? null : String(opportunity.expectedValue),
    lastInteractionAt: last,
    contactBase: last ? 'INTERACTION' : 'CREATED',
    daysWithoutContact: closed ? null : daysBetween(base, now),
    interactions,
    openTasks: timeline.filter((i) => i.type === 'TASK' && OPEN_TASK.includes(i.data.status)).map((t) => ({ id: t.id, title: t.data.title, dueAt: t.data.dueAt || null, status: t.data.status })),
    proposals: proposalsOf(sentProposals, interactions, now),
    pendingDocuments: documents,
    nextAction: opportunity.nextAction || null,
    asOf: now.toISOString(),
  };
}

module.exports = { loadOpportunityFacts, findOpportunity, CLOSED_STAGES };
