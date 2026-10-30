'use strict';

const { SCOPES, SOURCES } = require('./killswitch.constants');
const { changeKillSwitch } = require('./killswitch.change');
const errors = require('./killswitch.errors');

/**
 * Incidente CRITICAL suspende o outbound automático (M9-D425, Caderno §8): o módulo de incidentes da governança (bloco E) chama esta função e o Marketing aciona o escopo
 * GLOBAL com origem INCIDENT_CRITICAL e o id do incidente, na transação do chamador. Esse bloqueio só é desfeito pela reativação normal (MFA, motivo, auditoria) DEPOIS que o
 * incidente estiver resolvido (resolvedor registrado em killswitch.hooks). `actorUserId` é o responsável pelo incidente. O motivo padrão cita o incidente.
 */
async function activateFromIncident({ tenant, incidentId, actorUserId, reason, transaction, now }) {
  if (typeof incidentId !== 'string' || !incidentId.trim() || !actorUserId) throw errors.incidentInvalid({ fields: ['incidentId', 'actorUserId'] });
  const text = (typeof reason === 'string' && reason.trim()) || `Incidente crítico ${incidentId.trim()}: envios automáticos suspensos.`;
  return changeKillSwitch({
    tenant, actorUserId, transaction, now, source: SOURCES.INCIDENT_CRITICAL, incidentId: incidentId.trim(),
    input: { scope: SCOPES.GLOBAL, targetId: null, active: true, reason: text, compromised: false },
  });
}

module.exports = { activateFromIncident };
