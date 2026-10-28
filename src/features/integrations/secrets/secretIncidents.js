'use strict';

const logger = require('../../../utils/logger');

/**
 * Ponto de ligação para abrir incidente quando a credencial vence (M9-D202 regra 4). O registro de erros de integração
 * (M9-D207) registra o seu repórter aqui; sem repórter o vencimento fica na auditoria e no status AUTH_FAILED.
 */
const reporters = [];
const registerSecretIncidentReporter = (fn) => { reporters.push(fn); };
const clearSecretIncidentReporters = () => { reporters.length = 0; };

async function reportSecretIncident(incidente) {
  for (const fn of reporters) {
    try {
      await fn(incidente);
    } catch (err) {
      logger.warn({ code: incidente.code, connectionId: incidente.connectionId }, 'Falha ao registrar incidente de credencial vencida.');
    }
  }
}

module.exports = { registerSecretIncidentReporter, clearSecretIncidentReporters, reportSecretIncident };
