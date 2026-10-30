'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { expectedApprovedHash } = require('../../../integrations/social/social.content');

const PUBLISHABLE_STATUSES = Object.freeze(['APPROVED', 'SCHEDULED', 'PUBLISHING']);
const SYSTEM_APPROVER = 'SYSTEM_AUTOPUBLISH:';

/** A versão do job com o item dela (título, status, aprovação) para reconferir a aprovação e montar o que vai ao canal. */
async function loadVersion(job, transaction) {
  const rows = await sequelize.query(
    `SELECT i.id AS item_id, i.title, i.status, i.autopublish_class, i.current_version_id, v.id AS version_id, v.body_json, v.facts_snapshot_json,
            v.content_hash, v.template_id, v.approved_by, v.approved_hash
       FROM marketing.content_versions v JOIN marketing.content_items i ON i.id = v.content_item_id AND i.company_id = v.company_id
      WHERE v.id = :versionId AND v.company_id = :companyId AND i.deleted_at IS NULL`,
    { replacements: { versionId: job.content_version_id, companyId: job.company_id }, transaction, type: QueryTypes.SELECT }
  );
  return rows[0] || null;
}

/**
 * A aprovação continua valendo? (M9-D411 item 1.) Versão ainda é a corrente do item, item ainda aprovado/agendado, aprovação gravada (por regra só com a classe
 * autopublicável registrada) e hash aprovado igual ao recalculado agora (conteúdo ou template editado depois da aprovação não sai). Devolve { ok, reason, content }.
 */
async function checkApproval(job, transaction) {
  const content = await loadVersion(job, transaction);
  if (!content) return { ok: false, reason: 'VERSION_NOT_FOUND' };
  if (content.current_version_id !== job.content_version_id) return { ok: false, reason: 'VERSION_SUPERSEDED', content };
  if (!PUBLISHABLE_STATUSES.includes(content.status)) return { ok: false, reason: `ITEM_${content.status}`, content };
  if (!content.approved_by || !content.approved_hash) return { ok: false, reason: 'NOT_APPROVED', content };
  if (String(content.approved_by).startsWith(SYSTEM_APPROVER) && !content.autopublish_class) return { ok: false, reason: 'AUTOPUBLISH_CLASS_MISSING', content };
  if (content.approved_hash !== await expectedApprovedHash(content, transaction)) return { ok: false, reason: 'CHANGED_AFTER_APPROVAL', content };
  return { ok: true, content };
}

/** O que vai ao canal: os mesmos textos que o passo de conformidade já limpou (título, texto e corpo renderizado); a segunda barreira (M9-D403) limpa de novo. */
function buildPayload(content) {
  const body = content.body_json || {};
  return {
    titulo: content.title,
    texto: body.texto,
    ...(typeof body.renderizado === 'string' ? { corpo: body.renderizado } : {}),
  };
}

const addressPolicyOf = (content) => (content.facts_snapshot_json || {}).politicaEndereco;

module.exports = { loadVersion, checkApproval, buildPayload, addressPolicyOf, PUBLISHABLE_STATUSES };
