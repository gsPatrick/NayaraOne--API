'use strict';

const { registerOptOutHandler } = require('../../people/personConsents.service');
const { publishMarketingEvent } = require('../marketing.events.publish');
const { resolvePersonAddresses } = require('./address');
const { acquireSendLocks } = require('./sendLock');
const { cancelPendingForSuppression } = require('./suppression.effect');
const { suppress } = require('./suppression.service');

const ALL_PURPOSES = 'ALL';
const SOURCE = 'PEOPLE_SCREEN';

/**
 * M9-D419 regra 1 — OPT_OUT registrado em Pessoas (tela ou qualquer chamada de recordConsent). Na MESMA transação do consentimento:
 * cria a supressão (reason OPT_OUT; o consentimento já foi gravado) e emite customer.opted_out uma única vez. Pessoa sem endereço no
 * canal não tem como ter linha de supressão (ela é por endereço): o consentimento OPT_OUT já bloqueia o canSend, o agendado é
 * cancelado e o evento sai uma vez por registro.
 */
async function registerOptOutFromConsent({ person, consent, actorUserId }, transaction) {
  const tenant = { groupId: person.groupId, companyId: person.companyId };
  const purpose = consent.purpose === ALL_PURPOSES ? null : consent.purpose;
  const addresses = await resolvePersonAddresses(person.id, consent.channel, tenant, transaction);
  if (addresses.length > 0) {
    return suppress({ personId: person.id, channel: consent.channel, purpose, reason: 'OPT_OUT', source: SOURCE, actor: actorUserId, consentRecorded: true, occurredAt: new Date(consent.recordedAt).toISOString() }, tenant, transaction);
  }
  await acquireSendLocks(tenant, person.id, consent.channel, [purpose || ALL_PURPOSES], transaction);
  await cancelPendingForSuppression({ personIds: [person.id], channel: consent.channel, purpose }, tenant, transaction);
  await publishMarketingEvent({
    type: 'customer.opted_out', tenant, idempotencyKey: `customer.opted_out:consent:${consent.id}`,
    payload: { personId: person.id, channel: consent.channel, purpose: consent.purpose, source: SOURCE, occurredAt: new Date(consent.recordedAt).toISOString() },
  }, transaction);
  return { suppressions: [], replay: false, blockedRuns: [] };
}

registerOptOutHandler(registerOptOutFromConsent);

module.exports = { registerOptOutFromConsent };
