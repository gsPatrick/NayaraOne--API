'use strict';

/**
 * Portas do kill switch do Marketing para quem é dono de outra regra (M9-D425). Nenhuma delas é opcional para a SEGURANÇA: sem registro, o kill switch continua ligado.
 *  - Resolvedor de incidente (módulo de incidentes da governança, bloco E): `registerIncidentResolver(({ tenant, incidentId, transaction }) => boolean)`. Um bloqueio
 *    acionado por incidente CRITICAL só é desfeito com o incidente resolvido; sem resolvedor registrado vale "não resolvido" (falha fechada).
 *  - Tratador de conta comprometida (M9-D433): `registerCompromisedHandler(({ tenant, channel, reason, actorUserId, transaction }) => object)`, chamado quando o POST
 *    /marketing/kill-switch vem com `compromised:true`. Se ele falhar, o bloqueio do canal PERMANECE (D433: "falha do adapter ao revogar mantém o bloqueio").
 */
let incidentResolver = null;
let compromisedHandler = null;

function registerIncidentResolver(fn) {
  if (fn !== null && typeof fn !== 'function') throw new TypeError('O resolvedor de incidente precisa ser uma função.');
  incidentResolver = fn;
}

function registerCompromisedHandler(fn) {
  if (fn !== null && typeof fn !== 'function') throw new TypeError('O tratador de conta comprometida precisa ser uma função.');
  compromisedHandler = fn;
}

/** O incidente está resolvido? Sem resolvedor, ou se ele falhar, não está. */
async function isIncidentResolved(args) {
  if (!incidentResolver) return false;
  try { return (await incidentResolver(args)) === true; } catch (err) { return false; }
}

const getCompromisedHandler = () => compromisedHandler;

module.exports = { registerIncidentResolver, registerCompromisedHandler, isIncidentResolved, getCompromisedHandler };
