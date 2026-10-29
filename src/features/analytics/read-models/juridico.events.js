'use strict';

/**
 * M9-D619 (3.2) — eventos que atualizam os read models do Jurídico e do Correspondente Bancário. Nomes conferidos em src/features/legal
 * (legalEvents.service.js, legalDeadlineCalendarEvents.service.js, legalBiEvents.service.js) e src/features/correspondent
 * (correspondentEvents.service.js). DI-D619-1: os nomes do caderno `legal.deadline.*`, `legal.case.*`, `legal.contract_requirement.*`,
 * `correspondent.financing_case.status_changed`, `correspondent.proposal.*` e `correspondent.commission.*` valem como família; o código publica
 * `financing.status.changed`, `financing.approved|rejected`, `commission.*` e não tem evento de proposta (a proposta ativa entra pelos eventos
 * do caso e a agenda).
 */
module.exports = {
  DEADLINE_EVENTS: Object.freeze(['legal.deadline.created', 'legal.deadline.updated', 'legal.deadline.completed', 'legal.deadline.cancelled', 'legal.deadline.reopened']),
  CASE_EVENTS: Object.freeze(['legal.case.created', 'legal.case.updated']),
  REQUIREMENT_EVENTS: Object.freeze(['legal.contract_requirement.updated', 'legal.contract.status_changed', 'contract.activated', 'contract.terminated']),
  STAGE_EVENTS: Object.freeze(['financing.case.created', 'financing.status.changed', 'financing.submitted', 'financing.documents.completed']),
  OUTCOME_EVENTS: Object.freeze(['financing.approved', 'financing.rejected']),
  COMMISSION_EVENTS: Object.freeze(['commission.entitlement.created', 'commission.confirmed', 'commission.received', 'commission.adjusted']),
};
