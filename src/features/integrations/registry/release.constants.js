'use strict';

/** Constantes do portão de liberação para produção (M9-D256). */
const DRILL_SCENARIOS = Object.freeze(['provider-down', 'rate-limit', 'auth-failed', 'timeout', 'paused']);
const LAB_ENVIRONMENTS = Object.freeze(['SANDBOX', 'HOMOLOG']);
const STATES = Object.freeze({ NOT_RELEASED: 'NOT_RELEASED', RELEASED: 'RELEASED' });
const EVIDENCE_MISSING = 'INTEGRATION_RELEASE_EVIDENCE_MISSING';
const EVIDENCE_MESSAGE = 'Faltam evidências para liberar esta integração em produção.';

/** Evidências do livro 3.1, na ordem: 1 a 8 verificadas por máquina; 9 (aprovação humana com MFA) é verificada pelo serviço de liberação. */
const EVIDENCE_ITEMS = Object.freeze([
  'contractLive', 'contractTests', 'failureDrill', 'healthLab', 'healthCheck', 'runbook', 'slo', 'alerts', 'secret', 'webhookSecret', 'egress', 'contingency',
]);

module.exports = { DRILL_SCENARIOS, LAB_ENVIRONMENTS, STATES, EVIDENCE_MISSING, EVIDENCE_MESSAGE, EVIDENCE_ITEMS };
