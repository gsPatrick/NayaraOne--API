'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { getSetting } = require('../../../features/settings/settings.service');
const { AUTO_UPDATE_ON_SOURCE_CHANGE_KEY, MARKETING_SETTING_DEFAULTS } = require('../marketing.settings');
const { loadItemWithFacts } = require('./currentSource');
const { PRE_PUBLISHING_STATUSES, currentSourceOf, itemSourceChanged, blockStaleItem, listItemsOfSource } = require('./sourceStale');
const { createUpdateItem } = require('./sourceUpdate');

/**
 * M9-D405 regra 4 — vigia a fonte. Para cada conteúdo ligado à entidade que mudou (um por vez, com FOR UPDATE):
 * - PUBLISHED e fonte diferente -> cria a atualização (uma só: `superseded_by` já preenchido = já existe); o histórico não é tocado;
 * - ainda não publicado e fonte diferente -> FACT_CHECK_FAILED (MKT_SOURCE_STALE) e jobs PENDING cancelados;
 * - PUBLISHING, FAILED e ARCHIVED não são alterados.
 * Idempotente: rodar duas vezes para o mesmo estado da fonte não duplica nada. Retorna { updates, blocked, skipped }.
 */
async function processSourceChange({ entityType, entityId }, tenant, transaction, actorUserId = null) {
  const result = { updates: [], blocked: [], skipped: [] };
  const autoUpdate = await getSetting(AUTO_UPDATE_ON_SOURCE_CHANGE_KEY, tenant, transaction, MARKETING_SETTING_DEFAULTS[AUTO_UPDATE_ON_SOURCE_CHANGE_KEY]);

  for (const itemId of await listItemsOfSource(entityType, entityId, tenant, transaction)) {
    const item = await loadItemWithFacts(itemId, tenant, transaction, { lock: true });
    if (!item) continue;
    const current = await currentSourceOf(item, tenant, transaction);
    if (!current || !itemSourceChanged(item, current)) continue;

    if (item.status === 'PUBLISHED') {
      if (item.superseded_by) {
        result.skipped.push({ itemId, reason: 'ATUALIZACAO_JA_EXISTE' });
      } else if (autoUpdate === false) {
        result.skipped.push({ itemId, reason: 'ATUALIZACAO_AUTOMATICA_DESLIGADA' });
      } else {
        const created = await createUpdateItem(item, current, tenant, actorUserId, transaction);
        result.updates.push({ fromId: itemId, ...created });
      }
    } else if (PRE_PUBLISHING_STATUSES.includes(item.status)) {
      await blockStaleItem(item, current, tenant, actorUserId, transaction);
      result.blocked.push(itemId);
    } else {
      result.skipped.push({ itemId, reason: `ESTADO_${item.status}` });
    }
  }
  return result;
}

/** Evento property.updated: o agregado é o próprio imóvel. */
function onPropertyUpdated(event, transaction) {
  return processSourceChange({ entityType: 'property', entityId: event.aggregateId }, { groupId: event.groupId, companyId: event.companyId }, transaction);
}

/** Evento property.price.changed: o preço mora na oferta; o payload traz o imóvel dono dela (propertyId). */
async function onPropertyPriceChanged(event, transaction) {
  const propertyId = event.payloadJson && event.payloadJson.propertyId;
  if (!propertyId) return { updates: [], blocked: [], skipped: [{ reason: 'EVENTO_SEM_IMOVEL' }] };
  return processSourceChange({ entityType: 'property', entityId: propertyId }, { groupId: event.groupId, companyId: event.companyId }, transaction);
}

/** Leitura no agendamento: varre os imóveis com conteúdo ativo da empresa (cobre eventos perdidos). */
async function scanSourceChanges(tenant, transaction, actorUserId = null) {
  const rows = await sequelize.query(
    `SELECT DISTINCT source_entity_type, source_entity_id FROM marketing.content_items
      WHERE company_id = :companyId AND source_entity_id IS NOT NULL AND deleted_at IS NULL AND status <> 'ARCHIVED'`,
    { replacements: { companyId: tenant.companyId }, transaction, type: QueryTypes.SELECT }
  );
  const total = { updates: [], blocked: [], skipped: [] };
  for (const row of rows) {
    const r = await processSourceChange({ entityType: row.source_entity_type, entityId: row.source_entity_id }, tenant, transaction, actorUserId);
    total.updates.push(...r.updates);
    total.blocked.push(...r.blocked);
    total.skipped.push(...r.skipped);
  }
  return total;
}

module.exports = { processSourceChange, onPropertyUpdated, onPropertyPriceChanged, scanSourceChanges };
