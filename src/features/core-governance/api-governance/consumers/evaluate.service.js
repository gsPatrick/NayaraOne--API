'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, Notification } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { getSetting } = require('../../../settings/settings.service');
const { publishGovernanceEvent } = require('../../governance.events');
const { CHANNEL_IN_APP } = require('../../calendar/alerts/alerts.constants');
const S = require('./consumers.settings');
const repository = require('./deprecations.repository');
const { daysToSunset } = require('./days');
const { clearContextCache } = require('./context');

const EVENT = 'api.consumer.deprecation_due';
const eventKey = (consumerId, target) => `${EVENT}:${consumerId}:${target}`;

const wasPublished = async (key, transaction) => (await sequelize.query(
  'SELECT 1 AS ok FROM integration.outbox_events WHERE idempotency_key = :key LIMIT 1', { type: QueryTypes.SELECT, transaction, replacements: { key } }
)).length > 0;

/** Aviso IN_APP ao responsável do consumidor e ao da deprecação (a mesma pessoa recebe um só). */
async function notifyOwners(tenant, { consumer, deprecation, daysLeft }, transaction) {
  const title = `Deprecação de API: ${deprecation.target} sai do ar em ${daysLeft} dia(s)`;
  const body = `O consumidor "${consumer.name}" ainda usa ${deprecation.target}, que será desligado em ${new Date(deprecation.sunsetAt).toISOString()}.`
    + `${deprecation.replacement ? ` Migre para ${deprecation.replacement}.` : ''}`;
  for (const userId of new Set([consumer.ownerUserId, deprecation.ownerUserId])) {
    await Notification.create({ groupId: tenant.groupId, companyId: tenant.companyId, userId, channel: CHANNEL_IN_APP, title, body, createdBy: null, updatedBy: null }, { transaction });
  }
}

/**
 * Avaliação diária das deprecações de uma empresa (M9-D841 §3.4), na transação do tenant. Para cada deprecação ANNOUNCED: passado o `sunset_at`, vira SUNSET (auditada); senão, se faltam
 * `governanca.api.aviso_dias` dias ou menos, publica `api.consumer.deprecation_due` UMA vez por consumidor ativo que usou o alvo na janela e avisa os dois responsáveis. Evento e aviso saem
 * na mesma transação; reexecutar não duplica (chave de idempotência do evento). Devolve { announced, sunset, events, notified }.
 */
async function evaluateDeprecations({ tenant, now = new Date(), transaction }) {
  const read = (key) => getSetting(key, tenant, transaction, S.CONSUMERS_SETTING_DEFAULTS[key]);
  const warnDays = Number(await read(S.AVISO_DIAS_KEY));
  const activeDays = Number(await read(S.ATIVO_DIAS_KEY));
  const summary = { announced: 0, sunset: 0, events: 0, notified: 0 };
  for (const deprecation of await repository.lockAnnounced(tenant.companyId, transaction)) {
    summary.announced += 1;
    if (new Date(deprecation.sunsetAt).getTime() <= now.getTime()) {
      await repository.setStatus(tenant.companyId, deprecation.id, 'SUNSET', transaction);
      await registrarAuditoria({
        groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'api.deprecation.sunset', entityType: 'ApiDeprecation', entityId: deprecation.id,
        beforeJson: { status: 'ANNOUNCED' }, afterJson: { status: 'SUNSET' }, reason: `Deprecação de ${deprecation.target} chegou ao desligamento.`,
      }, transaction);
      summary.sunset += 1;
      continue;
    }
    const daysLeft = daysToSunset(deprecation.sunsetAt, now);
    if (new Date(deprecation.announcedAt).getTime() > now.getTime() || daysLeft > warnDays) continue;
    for (const consumer of await repository.activeConsumersOf(tenant.companyId, deprecation.target, activeDays, transaction)) {
      const idempotencyKey = eventKey(consumer.id, deprecation.target);
      if (await wasPublished(idempotencyKey, transaction)) continue;
      await publishGovernanceEvent({
        groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: 'ApiConsumer', aggregateId: consumer.id, eventType: EVENT, idempotencyKey,
        payload: { consumerId: consumer.id, target: deprecation.target, sunsetAt: new Date(deprecation.sunsetAt).toISOString(), daysLeft },
      }, transaction);
      await notifyOwners(tenant, { consumer, deprecation, daysLeft }, transaction);
      summary.events += 1;
      summary.notified += 1;
    }
  }
  if (summary.sunset) clearContextCache(tenant.companyId);
  return summary;
}

module.exports = { evaluateDeprecations, eventKey, EVENT };
