'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { findTemplate } = require('../../marketing/content/approval.repository');
const { computeApprovedHash } = require('../../marketing/content/template.hash');

/** O item de conteúdo da empresa com a versão CORRENTE (corpo, hash e aprovação). `lock`: trava o item (agendamento sob FOR UPDATE). */
async function loadContent(companyId, itemId, transaction, { lock = false } = {}) {
  const rows = await sequelize.query(
    `SELECT i.id AS item_id, i.status, i.type, i.nay_run_id, i.autopublish_class, i.campaign_id, i.source_entity_type, i.source_entity_id,
            v.id AS version_id, v.version_no, v.body_json, v.content_hash, v.template_id, v.approved_by, v.approved_at, v.approved_hash
       FROM marketing.content_items i
       LEFT JOIN marketing.content_versions v ON v.id = i.current_version_id AND v.company_id = i.company_id
      WHERE i.id = :itemId AND i.company_id = :companyId AND i.deleted_at IS NULL ${lock ? 'FOR UPDATE OF i' : ''}`,
    { replacements: { itemId, companyId }, transaction, type: QueryTypes.SELECT }
  );
  return rows[0] || null;
}

/**
 * O hash que a versão aprovada DEVERIA ter agora (conteúdo + template usado, M9-D404), calculado sem gravar nada. Se não coincide com o
 * `approved_hash` guardado, o conteúdo ou o template mudou depois da aprovação.
 */
async function expectedApprovedHash(content, transaction) {
  const template = content.template_id ? await findTemplate(content.template_id, transaction) : null;
  return computeApprovedHash({
    contentHash: content.content_hash,
    templateId: template ? template.id : null,
    templateVersionNo: template ? template.version_no : null,
    templateContentHash: template ? template.content_hash : null,
  });
}

module.exports = { loadContent, expectedApprovedHash };
