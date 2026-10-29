'use strict';

/**
 * M9-D628 (3.2) — eventos do outbox que recalculam os read models de Tecnologia e IA. Nomes conferidos nos catálogos de origem: integrations/dispatch
 * (dispatch.events.js, dispatch.transition) e integrations/registry, ai/events/aiEvents.catalog.js, ai/evaluations/evaluations.constants.js e
 * marketing/marketing.events.catalog.js. DI-D628-2: o caderno cita `integration.health.checked`, que o código não publica (o health grava provider_health pelo job de
 * agregação); a saúde entra pela agenda e pelos eventos do envio. Disponibilidade, filas, freshness e falhas de autenticação não têm evento: dependem do relógio.
 */
module.exports = {
  INTEGRATION_EVENTS: Object.freeze(['integration.dispatch.confirmed', 'integration.dispatch.failed', 'integration.provider.changed']),
  BLOCKED_EVENTS: Object.freeze(['automation.run.blocked', 'integration.dispatch.failed']),
  AI_COST_EVENTS: Object.freeze(['ai.run.completed', 'ai.run.failed', 'ai.budget.threshold_reached']),
  AI_QUALITY_EVENTS: Object.freeze(['ai.run.completed', 'ai.evaluation.finished']),
  AI_TOOL_EVENTS: Object.freeze(['ai.tool_call.blocked', 'ai.run.completed']),
};
