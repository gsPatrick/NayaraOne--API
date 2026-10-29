'use strict';

const { effectiveConsent } = require('./canSend');
const { classifyPurpose } = require('./purposes');
const { resolvePersonAddresses } = require('./address');
const { findActiveSuppression } = require('./suppression.repository');

/**
 * M9-D419 regra 4 — abertura e clique só identificam a pessoa com consentimento do canal. `mayIdentify` é a decisão: sem
 * supressão ativa, sem OPT_OUT e, para a finalidade que exige OPT_IN (padrão MARKETING), com OPT_IN. Quem rastreia (redirecionamento
 * do link, pixel de abertura) chama aqui; se a resposta for `identify: false`, grava só a contagem anônima (person_id nulo).
 * Devolve { identify, reason } com reason SUPPRESSED, OPT_OUT, NO_CONSENT ou null.
 */
async function mayIdentify(personId, channel, tenant, transaction, purpose = 'MARKETING') {
  const ch = String(channel || '').toUpperCase();
  const { purpose: p, requiresOptIn } = await classifyPurpose(purpose, tenant, transaction);
  const addresses = await resolvePersonAddresses(personId, ch, tenant, transaction);
  const suppression = await findActiveSuppression({ hashes: addresses.map((a) => a.hash), personId, channel: ch, purpose: p, at: new Date() }, tenant, transaction);
  if (suppression) return { identify: false, reason: 'SUPPRESSED' };
  const consent = await effectiveConsent(personId, ch, p, transaction);
  if (consent && consent.status === 'OPT_OUT') return { identify: false, reason: 'OPT_OUT' };
  if (requiresOptIn && !(consent && consent.status === 'OPT_IN')) return { identify: false, reason: 'NO_CONSENT' };
  return { identify: true, reason: null };
}

module.exports = { mayIdentify };
