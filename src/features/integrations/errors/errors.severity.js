'use strict';

const { SEVERITIES } = require('./errors.constants');

/**
 * Severidade padrão (M9-D207 regra 3): AUTH e SECURITY = HIGH; UNKNOWN em operação DANGEROUS = CRITICAL;
 * VALIDATION = MEDIUM; TRANSIENT e RATE_LIMIT = LOW até esgotar as tentativas, quando viram HIGH.
 * UNKNOWN fora de operação perigosa: o livro não define; fica MEDIUM (DI-D207-3).
 */
function severityFor({ errorClass, dangerous = false, attempts = 1, exhaustedAttempts = 5 }) {
  switch (errorClass) {
    case 'AUTH':
    case 'SECURITY':
      return 'HIGH';
    case 'UNKNOWN':
      return dangerous ? 'CRITICAL' : 'MEDIUM';
    case 'VALIDATION':
      return 'MEDIUM';
    case 'TRANSIENT':
    case 'RATE_LIMIT':
      return attempts >= exhaustedAttempts ? 'HIGH' : 'LOW';
    default:
      return 'MEDIUM';
  }
}

const maxSeverity = (a, b) => (SEVERITIES.indexOf(a) >= SEVERITIES.indexOf(b) ? a : b);

module.exports = { severityFor, maxSeverity };
