'use strict';

const { registerEventConsumer } = require('../../../engines/events/consumers');
const { consumeMarketingEvent } = require('../marketing.events.consume');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { resolvePersonAddresses } = require('./address');
const { acquireSendLocks } = require('./sendLock');
const repo = require('./suppression.repository');
const { cancelPendingForSuppression } = require('./suppression.effect');

/**
 * M9-D419 regra 2 — consumidor de customer.opted_out (uma vez por eventId). (a) Confere, de forma idempotente, que a supressão do
 * endereço da pessoa no canal existe; a que faltar é criada com INSERT ... ON CONFLICT DO NOTHING e NUNCA emite novo evento (sem
 * laço). Não recria a supressão de quem deu um novo OPT_IN depois do pedido. (b) Cancela o que está agendado para a pessoa e o canal
 * (ações SCHEDULED, runs WAITING; os steps de campanha são cancelados na hora do envio pelo canSend, DI-D418-2).
 */
const CONSUMER = 'marketing.optout.listener';
const ALL_PURPOSES = 'ALL';

async function optedInAfter({ personId, channel, purpose, occurredAt }, tenant, transaction) {
  const [row] = await sequelize.query(
    `SELECT 1 AS ok FROM people.communication_consents WHERE company_id = :companyId AND person_id = :personId AND channel = :channel
        AND status = 'OPT_IN' AND purpose IN ('ALL', :purpose) AND recorded_at > :at LIMIT 1`,
    { replacements: { companyId: tenant.companyId, personId, channel, purpose, at: occurredAt || new Date(0) }, type: QueryTypes.SELECT, transaction }
  );
  return Boolean(row);
}

async function ensureSuppressions(payload, tenant, transaction) {
  const purpose = payload.purpose === ALL_PURPOSES ? null : payload.purpose;
  if (await optedInAfter({ ...payload, purpose: payload.purpose }, tenant, transaction)) return 0;
  await acquireSendLocks(tenant, payload.personId, payload.channel, [purpose || ALL_PURPOSES], transaction);
  let created = 0;
  for (const { hash } of await resolvePersonAddresses(payload.personId, payload.channel, tenant, transaction)) {
    const result = await repo.insertSuppression({
      personId: payload.personId, addressHash: hash, channel: payload.channel, purpose, reason: 'OPT_OUT', source: `EVENT:${payload.source}`.slice(0, 60),
    }, tenant, transaction);
    if (!result.created) continue;
    created += 1;
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'marketing.suppression.created', entityType: 'marketing.suppression', entityId: result.row.id,
      beforeJson: null, afterJson: { channel: payload.channel, purpose, reason: 'OPT_OUT', source: result.row.source, addressHash: hash }, reason: 'Supressão conferida pelo consumidor de customer.opted_out.',
    }, transaction);
  }
  return created;
}

async function handleOptedOut(envelope, transaction) {
  const tenant = { groupId: envelope.groupId, companyId: envelope.companyId };
  const payload = envelope.payload;
  const created = await ensureSuppressions({ ...payload, occurredAt: payload.occurredAt || envelope.occurredAt }, tenant, transaction);
  const purpose = payload.purpose === ALL_PURPOSES ? null : payload.purpose;
  const blockedRuns = await cancelPendingForSuppression({ personIds: [payload.personId], channel: payload.channel, purpose }, tenant, transaction);
  return { created, blockedRuns };
}

const onOptedOut = (row, transaction) => consumeMarketingEvent(row, CONSUMER, handleOptedOut, transaction);

registerEventConsumer('customer.opted_out', CONSUMER, onOptedOut);

module.exports = { CONSUMER, onOptedOut, handleOptedOut };
