'use strict';

const { SCOPES, SOURCES } = require('../killswitch.constants');

/** O provedor informou que a credencial foi REVOGADA (código AUTH_REVOKED), em vez de apenas expirada ou recusada? */
const REVOKED_CODE = 'AUTH_REVOKED';
const isAuthRevoked = (error) => Boolean(error && (error.code === REVOKED_CODE || error.providerCode === REVOKED_CODE));

/**
 * M9-D433 — o sinal automático de conta comprometida: revogação informada pelo provedor. Aciona o mesmo caminho da marcação manual (kill switch CHANNEL com `compromised`),
 * na transação de quem detectou (o worker de publicação). O ator é o responsável pelos kill switches da empresa. Idempotente: canal já travado como comprometido não repete a auditoria.
 */
async function reportAuthRevoked({ tenant, channel, transaction, now }) {
  const { changeKillSwitch, responsibleFor } = require('../killswitch.service'); // carga tardia: a fachada registra o probe e o provisionador do kill switch
  const actorUserId = await responsibleFor(tenant, transaction);
  return changeKillSwitch({
    tenant, actorUserId, transaction, now, source: SOURCES.COMPROMISED_ACCOUNT,
    input: { scope: SCOPES.CHANNEL, targetId: String(channel).toUpperCase(), active: true, compromised: true, reason: 'Revogação da credencial informada pelo provedor (AUTH_REVOKED).' },
  });
}

module.exports = { isAuthRevoked, reportAuthRevoked };
