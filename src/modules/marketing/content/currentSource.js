'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { loadPublicProperty, loadPublicConstruction } = require('./publicReadModel');

/**
 * M9-D405 — leitura da fonte AGORA (sempre pelos read models públicos da M9-D403, nunca pelas tabelas de origem) e leitura do que o
 * item guardou (versão da fonte e hash dos fatos da versão corrente).
 */
async function loadCurrentSource(entityType, entityId, tenant, transaction) {
  if (entityType === 'property') {
    const model = await loadPublicProperty({ propertyId: entityId }, tenant, transaction);
    return { version: model.sourceVersion, facts: model.payload };
  }
  if (entityType === 'construction') {
    const model = await loadPublicConstruction({ projectId: entityId }, tenant, transaction);
    return { version: null, facts: model.payload };
  }
  return null;
}

/** Item com o hash dos fatos da versão corrente (ou da mais recente, se a corrente ainda não foi ligada). */
async function loadItemWithFacts(itemId, tenant, transaction, { lock = false } = {}) {
  const rows = await sequelize.query(
    `SELECT i.*, v.id AS version_id, v.facts_hash, v.facts_snapshot_json, v.template_id AS version_template_id,
            v.template_version_no AS version_template_version_no
       FROM marketing.content_items i
       LEFT JOIN marketing.content_versions v ON v.company_id = i.company_id AND v.content_item_id = i.id
            AND v.version_no = (SELECT max(v2.version_no) FROM marketing.content_versions v2 WHERE v2.content_item_id = i.id AND v2.company_id = i.company_id)
      WHERE i.id = :itemId AND i.company_id = :companyId AND i.deleted_at IS NULL ${lock ? 'FOR UPDATE OF i' : ''}`,
    { replacements: { itemId, companyId: tenant.companyId }, transaction, type: QueryTypes.SELECT }
  );
  return rows[0] || null;
}

module.exports = { loadCurrentSource, loadItemWithFacts };
