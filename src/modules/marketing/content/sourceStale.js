'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { mktSourceStale } = require('../marketing.errors');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { isSourceChanged } = require('./sourceStamp');
const { loadCurrentSource, loadItemWithFacts } = require('./currentSource');

/**
 * M9-D405 regra 4 (conteúdo ainda não publicado) — se a fonte mudou, o item não segue: volta a FACT_CHECK_FAILED com MKT_SOURCE_STALE
 * e os jobs PENDING das suas versões são CANCELLED até regerar. "Ainda não publicado" = todo estado anterior a PUBLISHING (M9-D406).
 */
const PRE_PUBLISHING_STATUSES = Object.freeze([
  'DRAFT', 'FACT_CHECK_FAILED', 'FACT_CHECKED', 'BRANDED', 'COMPLIANCE_CHECKED', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED',
]);

async function currentSourceOf(item, tenant, transaction) {
  if (!item.source_entity_type || !item.source_entity_id) return null;
  try {
    return await loadCurrentSource(item.source_entity_type, item.source_entity_id, tenant, transaction);
  } catch (err) {
    if (err.code === 'MKT_SOURCE_NOT_FOUND') return null; // fonte retirada do público: não há "nova versão" para comparar
    throw err;
  }
}

function itemSourceChanged(item, current) {
  return isSourceChanged({ storedVersion: item.source_version, storedFactsHash: item.facts_hash }, current);
}

/** Usado por quem aprova/agenda/publica (M9-D406): 409 MKT_SOURCE_STALE se a fonte mudou desde a geração. */
async function assertSourceFresh(itemId, tenant, transaction) {
  const item = await loadItemWithFacts(itemId, tenant, transaction);
  if (!item) throw AppError.notFound('Conteúdo não encontrado.', 'MKT_CONTENT_NOT_FOUND');
  const current = await currentSourceOf(item, tenant, transaction);
  if (current && itemSourceChanged(item, current)) {
    throw mktSourceStale({ contentItemId: itemId, storedSourceVersion: item.source_version, currentSourceVersion: current.version });
  }
  return { fresh: true };
}

/** Devolve o item não publicado ao fact-check e cancela os jobs PENDING; idempotente (já em FACT_CHECK_FAILED só garante os jobs). */
async function blockStaleItem(item, current, tenant, actorUserId, transaction) {
  const detectedAt = new Date().toISOString();
  const mark = { code: 'MKT_SOURCE_STALE', detectedAt, storedSourceVersion: item.source_version, currentSourceVersion: current.version };
  if (item.status !== 'FACT_CHECK_FAILED') {
    await sequelize.query(
      'UPDATE marketing.content_items SET status = \'FACT_CHECK_FAILED\', updated_by = :actor, updated_at = now() WHERE id = :id AND company_id = :companyId',
      { replacements: { id: item.id, companyId: tenant.companyId, actor: actorUserId || null }, transaction }
    );
    if (item.version_id) {
      await sequelize.query(
        'UPDATE marketing.content_versions SET checks_json = jsonb_set(checks_json, \'{sourceStale}\', CAST(:mark AS jsonb), true) WHERE id = :vid AND company_id = :companyId',
        { replacements: { vid: item.version_id, companyId: tenant.companyId, mark: JSON.stringify(mark) }, transaction }
      );
    }
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'marketing.content.source_stale_blocked',
      entityType: 'MarketingContentItem', entityId: item.id, beforeJson: { status: item.status },
      afterJson: { status: 'FACT_CHECK_FAILED', ...mark }, reason: 'Os dados do imóvel mudaram; o conteúdo voltou para revisão.',
    }, transaction);
  }
  const [, meta] = await sequelize.query(
    `UPDATE marketing.publication_jobs SET status = 'CANCELLED', last_error_code = 'MKT_SOURCE_STALE', updated_at = now()
      WHERE company_id = :companyId AND status = 'PENDING'
        AND content_version_id IN (SELECT id FROM marketing.content_versions WHERE content_item_id = :id AND company_id = :companyId)`,
    { replacements: { id: item.id, companyId: tenant.companyId }, transaction }
  );
  return { cancelledJobs: meta && meta.rowCount ? meta.rowCount : 0 };
}

async function listItemsOfSource(entityType, entityId, tenant, transaction) {
  const rows = await sequelize.query(
    `SELECT id FROM marketing.content_items WHERE company_id = :companyId AND source_entity_type = :entityType
        AND source_entity_id = :entityId AND deleted_at IS NULL AND status <> 'ARCHIVED' ORDER BY created_at, id`,
    { replacements: { companyId: tenant.companyId, entityType, entityId }, transaction, type: QueryTypes.SELECT }
  );
  return rows.map((r) => r.id);
}

module.exports = { PRE_PUBLISHING_STATUSES, currentSourceOf, itemSourceChanged, assertSourceFresh, blockStaleItem, listItemsOfSource };
