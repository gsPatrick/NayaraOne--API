'use strict';

/**
 * M9-D691 (3.2) — estados e transições do alerta. OPEN -> ACKNOWLEDGED (reconhecimento humano, M9-D703), OPEN -> RESOLVED e ACKNOWLEDGED ->
 * RESOLVED (normalização). RESOLVED é final. Qualquer outra transição responde 409 ANALYTICS_ALERT_INVALID_TRANSITION com a mensagem única
 * "Transição de alerta inválida: {de} -> {para}." (dona do texto: esta demanda; a M9-D703 só a usa).
 */
const AppError = require('../../../utils/AppError');

const STATES = Object.freeze(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']);
const ALLOWED = Object.freeze({ OPEN: ['ACKNOWLEDGED', 'RESOLVED'], ACKNOWLEDGED: ['RESOLVED'], RESOLVED: [] });

function assertTransition(from, to) {
  if (!STATES.includes(from) || !STATES.includes(to) || !ALLOWED[from].includes(to)) {
    throw AppError.conflict(`Transição de alerta inválida: ${from} -> ${to}.`, 'ANALYTICS_ALERT_INVALID_TRANSITION', { from, to });
  }
}

module.exports = { STATES, ALLOWED, assertTransition };
