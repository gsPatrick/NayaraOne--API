'use strict';

/**
 * M9-D413 — Catálogo da definição de automações: ÚNICO ponto de extensão (novo gatilho ou nova ação entra aqui e em mais nenhum lugar).
 * Gatilhos = eventos de domínio que o outbox já publica (nomes exatos de eventType). Ações = as 7 do livro (MKT-006, Guia §3).
 */
const TRIGGER_TYPES = Object.freeze(['EVENT', 'SCHEDULE']);
const RISK_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);
const COOLDOWN_UNITS = Object.freeze(['HOURS', 'DAYS']);
const FREQUENCY_SCOPES = Object.freeze(['PERSON_CHANNEL_PURPOSE']);
const MAX_ACTIONS = 10;

const ACTION_TYPES = Object.freeze([
  'SEND_MESSAGE', 'CREATE_TASK', 'NOTIFY_USER', 'CREATE_CONTENT_DRAFT', 'REQUEST_REVIEW', 'OPEN_CASE', 'UPDATE_CRM_STAGE_TAG',
]);

const TRIGGER_EVENTS = Object.freeze([
  'person.created', 'person.updated',
  'crm.opportunity.created', 'crm.opportunity.stage_changed', 'crm.opportunity.won', 'crm.opportunity.lost',
  'crm.visit.completed', 'crm.proposal.created', 'crm.proposal.status_changed', 'crm.interaction.recorded',
  'crm.cart.viewed', 'crm.cart.property_clicked',
  'crm.feedback_case.created', 'crm.feedback_case.escalated', 'crm.feedback_case.resolved',
  'crm.satisfaction.recorded',
  'property.created', 'property.published', 'property.updated', 'property.price.changed', 'property.offer.created',
  'radar.matched',
  'contract.activated', 'contract.terminated', 'keys.delivered', 'lease.guarantee.expiring', 'rent.adjusted',
  'inspection.difference.detected',
  'legal.contract.status_changed', 'legal.signature.signed', 'legal.deadline.alert', 'legal.guarantee.ended',
  'project.delivered', 'project.warranty_started', 'warranty.case.opened', 'warranty.case.closed',
  'finance.entry.settled',
]);

module.exports = { TRIGGER_TYPES, RISK_LEVELS, COOLDOWN_UNITS, FREQUENCY_SCOPES, MAX_ACTIONS, ACTION_TYPES, TRIGGER_EVENTS };
