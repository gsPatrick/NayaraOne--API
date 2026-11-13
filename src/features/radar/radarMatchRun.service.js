'use strict';

const { OutboxEvent, Notification, PropertyRadar } = require('../../models');
const { matchRadarToProperties } = require('./radarMatching.service');
const { publishRadarMatched } = require('./radarEvents.service');
const { recordRadarMatches } = require('./radarMatchStore.service');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * Uma rodada de matching de UM radar (CRMX-007, livro §13/§17, Guia §9), a mesma para o job periódico (rede de segurança) e para
 * o consumidor de eventos (radarEventConsumers.js): grava os matches em crm.radar_matches (ON CONFLICT na impressão digital dos
 * critérios: reprocessar não duplica) com o evento do livro `crm.radar.match.created` só no que nasceu agora e, para o par
 * radar+imóvel ainda não avisado, publica `radar.matched`, notifica quem criou o radar e audita. Reprocessar o mesmo radar (ou o
 * mesmo evento) não gera match, evento, notificação nem auditoria de novo.
 *
 * `propertyId` restringe a varredura a um imóvel (evento de oferta/imóvel); `origin` diz quem disparou (JOB | EVENT).
 */
const ORIGIN_TEXT = {
  JOB: 'Job automático do Radar',
  EVENT: 'Matching por evento do Radar',
};

async function runRadarMatching(radar, transaction, { propertyId = null, origin = 'JOB', sourceEventType = null } = {}) {
  const matches = await matchRadarToProperties(radar, transaction, propertyId ? { propertyId } : {});
  if (matches.length === 0) return { newMatches: 0, storedMatches: 0 };
  const stored = await recordRadarMatches(radar, matches, transaction);

  // "Já avisado" = o par (radar, imóvel) já gerou radar.matched (a idempotency_key do outbox é a fonte da verdade).
  const alreadyNotified = await OutboxEvent.findAll({
    where: { aggregateType: 'PropertyRadar', aggregateId: radar.id, eventType: 'radar.matched' },
    attributes: ['idempotencyKey'],
    transaction,
  });
  const notifiedKeys = new Set(alreadyNotified.map((e) => e.idempotencyKey));
  const newMatches = matches.filter((property) => !notifiedKeys.has(`radar.matched:${radar.id}:${property.id}`));
  if (newMatches.length === 0) return { newMatches: 0, storedMatches: stored.length };

  for (const property of newMatches) await publishRadarMatched(radar, property, transaction);

  if (radar.createdBy) {
    await Notification.create(
      {
        groupId: radar.groupId,
        companyId: radar.companyId,
        userId: radar.createdBy,
        channel: 'IN_APP',
        title: 'Novo match no Radar',
        body: `Encontramos ${newMatches.length} imóve${newMatches.length === 1 ? 'l novo compatível' : 'is novos compatíveis'} com um radar de busca que você criou.`,
        createdBy: null,
        updatedBy: null,
      },
      { transaction }
    );
  }

  await registrarAuditoria(
    {
      groupId: radar.groupId,
      companyId: radar.companyId,
      actorUserId: null,
      action: origin === 'EVENT' ? 'radar.event_matched' : 'radar.job_matched',
      entityType: 'PropertyRadar',
      entityId: radar.id,
      afterJson: { newMatchPropertyIds: newMatches.map((p) => p.id), sourceEventType },
      reason: `${ORIGIN_TEXT[origin] || ORIGIN_TEXT.JOB} encontrou ${newMatches.length} novo(s) match(es) para este radar.`,
    },
    transaction
  );

  return { newMatches: newMatches.length, storedMatches: stored.length };
}

/** Imóvel novo ou alterado (oferta, preço, status, atributos): roda cada radar ACTIVE da empresa contra ESTE imóvel. */
async function runMatchingForProperty(propertyId, tenant, transaction, sourceEventType = null) {
  const radars = await PropertyRadar.findAll({
    where: { groupId: tenant.groupId, companyId: tenant.companyId, status: 'ACTIVE' },
    transaction,
  });
  const summary = { radarsChecked: radars.length, newMatches: 0, storedMatches: 0 };
  for (const radar of radars) {
    const r = await runRadarMatching(radar, transaction, { propertyId, origin: 'EVENT', sourceEventType });
    summary.newMatches += r.newMatches;
    summary.storedMatches += r.storedMatches;
  }
  return summary;
}

module.exports = { runRadarMatching, runMatchingForProperty };
