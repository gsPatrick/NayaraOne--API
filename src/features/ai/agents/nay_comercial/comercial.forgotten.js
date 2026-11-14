'use strict';

// Livro do Marco 3 §16: "Detecta lead esquecido". Lead esquecido = oportunidade aberta sem contato (mensagem ou visita que aconteceu) há mais
// de `ia.comercial.lead_esquecido.dias_sem_contato` dias; sem nenhum contato, conta desde a abertura (a mesma conta de dias do resumo,
// comercial.data.js). Serve à capacidade sob demanda `detectar_leads_esquecidos` (na carteira de quem pede) e à rotina automática
// (nayComercialForgottenLeadsJob), que dirige a recomendação ao responsável da oportunidade sem ninguém perguntar.
const { Op } = require('sequelize');
const { Opportunity, AiRecommendation } = require('../../../../models');
const { loadOpportunityFacts, CLOSED_STAGES } = require('./comercial.data');
const { ownerWhere } = require('./comercial.scope');
const { dateBR, plural } = require('./comercial.format');

const TYPE = 'LEAD_ESQUECIDO';
const ENTITY = 'CRM_OPPORTUNITY';
const DAY_MS = 86400000;
const SCAN_MAX = 2000;

/**
 * Oportunidades abertas da carteira (`ownerScope`) com mais de `days` dias sem contato em `now`, da mais esquecida para a menos. A abertura
 * mais nova que o prazo nem é lida (não pode estar esquecida). Devolve [{ facts, ownerUserId }].
 */
async function findForgottenLeads(transaction, { now = new Date(), days, ownerScope = null }) {
  const candidates = await Opportunity.findAll({
    where: { stage: { [Op.notIn]: CLOSED_STAGES }, created_at: { [Op.lt]: new Date(now.getTime() - days * DAY_MS) }, ...ownerWhere(ownerScope) },
    attributes: ['id', 'ownerUserId'], order: [['created_at', 'ASC']], limit: SCAN_MAX, transaction,
  });
  const out = [];
  for (const o of candidates) {
    const facts = await loadOpportunityFacts(o.id, transaction, { now });
    if (!facts.closed && Number.isInteger(facts.daysWithoutContact) && facts.daysWithoutContact > days) out.push({ facts, ownerUserId: o.ownerUserId || null });
  }
  return out.sort((a, b) => b.facts.daysWithoutContact - a.facts.daysWithoutContact);
}

const lastContactText = (f) => (f.lastInteractionAt ? `último contato em ${dateBR(f.lastInteractionAt)}` : 'nenhum contato desde a abertura');

/** Recomendação ao responsável (sem ação proposta: aceitar só marca como vista; quem retoma o contato é a pessoa). */
function forgottenRecommendation(f) {
  return {
    type: TYPE, entityType: ENTITY, entityId: f.opportunityId, riskLevel: 'LOW',
    title: `Lead esquecido: ${f.customerName || 'cliente'} sem contato há ${f.daysWithoutContact} ${plural(f.daysWithoutContact, 'dia', 'dias')}`.slice(0, 200),
    rationale: `Oportunidade na etapa ${f.stage}, ${lastContactText(f)}. Sugestão: retomar o contato.`,
    payload: { diasSemContato: f.daysWithoutContact, ultimoContatoEm: f.lastInteractionAt, base: f.contactBase, etapa: f.stage, deteccao: 'AUTOMATICA' },
  };
}

/**
 * Já houve recomendação de lead esquecido desta oportunidade depois do último contato? (idempotência da rotina: a mesma ausência de
 * contato gera UMA recomendação; um contato novo seguido de novo silêncio gera outra).
 */
async function alreadyRecommended(companyId, facts, transaction) {
  const since = facts.lastInteractionAt ? new Date(facts.lastInteractionAt) : new Date(0);
  const found = await AiRecommendation.findOne({ where: { companyId, relatedEntityId: facts.opportunityId, recommendationType: TYPE, created_at: { [Op.gte]: since } }, attributes: ['id'], transaction });
  return Boolean(found);
}

/** Resposta da capacidade sob demanda (lista com fonte). */
function forgottenListResult(list, { days, listMax, now }) {
  const asOf = now.toISOString();
  const shown = list.slice(0, listMax);
  const head = list.length
    ? `Leads esquecidos na sua carteira [1]: ${list.length} ${plural(list.length, 'oportunidade', 'oportunidades')} sem contato há mais de ${days} ${plural(days, 'dia', 'dias')}${list.length > shown.length ? `, mostrando as ${shown.length} mais antigas` : ''}.`
    : `Nenhum lead esquecido na sua carteira: todas as oportunidades abertas tiveram contato nos últimos ${days} ${plural(days, 'dia', 'dias')} [1].`;
  const linhas = shown.map(({ facts: f }, i) => `${i + 1}. ${f.customerName || 'Cliente'} — etapa ${f.stage}, ${f.daysWithoutContact} ${plural(f.daysWithoutContact, 'dia', 'dias')} sem contato (${lastContactText(f)}).`);
  return {
    answer: [head, ...linhas].join('\n'),
    snapshotAt: asOf,
    structured: { tipo: 'LEADS_ESQUECIDOS', prazoDias: days, total: list.length, oportunidades: shown.map(({ facts: f, ownerUserId }) => ({ id: f.opportunityId, cliente: f.customerName, etapa: f.stage, diasSemContato: f.daysWithoutContact, ultimoContatoEm: f.lastInteractionAt, responsavel: ownerUserId })) },
    sources: [{ sourceType: 'READ_MODEL', sourceRef: 'crm.opportunities:sem-contato', title: 'crm.opportunities', retrievedAt: asOf, text: `Oportunidades abertas sem contato há mais de ${days} dias: ${list.length}. ${shown.map(({ facts: f }) => `${f.customerName || 'Cliente'}: ${f.daysWithoutContact} dias`).join('; ')}` }],
  };
}

module.exports = { findForgottenLeads, forgottenRecommendation, alreadyRecommended, forgottenListResult, TYPE, ENTITY };
