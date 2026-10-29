'use strict';

/**
 * M9-D617 (3.2) — eventos que atualizam os read models de Locação. Nomes conferidos nos serviços: legal/legalEvents.service.js,
 * legal/legalCalendarEvents.service.js, finance/financeEvents.service.js, construction/constructionEvents.service.js, crm/feedbackCases.service.js
 * e properties/propertyEvents.service.js. O que não tem evento no momento (parcela vencendo, garantia chegando ao fim) entra pela agenda (DI-D617-4).
 */
const CONTRACT_EVENTS = Object.freeze(['legal.contract.status_changed', 'contract.activated', 'contract.terminated']);
const PROPERTY_EVENTS = Object.freeze(['property.created', 'property.updated', 'property.sold', 'property.rented', 'property.merged', 'property.offer.created']);
const GUARANTEE_EVENTS = Object.freeze(['legal.guarantee.created', 'legal.guarantee.updated', 'legal.guarantee.ended', 'legal.guarantee.replaced', 'lease.guarantee.expiring']);
const ENTRY_EVENTS = Object.freeze(['finance.entry.created', 'finance.entry.settled', 'finance.entry.reversed', 'finance.entry.canceled']);
const INSPECTION_KEY_EVENTS = Object.freeze(['legal.inspection.completed', 'legal.key_delivery.released', 'keys.delivered']);
const TICKET_EVENTS = Object.freeze(['warranty.case.opened', 'warranty.case.closed', 'warranty.case.escalated']);
const FEEDBACK_EVENTS = Object.freeze(['crm.feedback_case.created', 'crm.feedback_case.resolved', 'crm.feedback_case.escalated']);
const REPASS_EVENTS = Object.freeze(['finance.owner_repasse.created', 'finance.owner_repass.completed']);

module.exports = { CONTRACT_EVENTS, PROPERTY_EVENTS, GUARANTEE_EVENTS, ENTRY_EVENTS, INSPECTION_KEY_EVENTS, TICKET_EVENTS, FEEDBACK_EVENTS, REPASS_EVENTS };
