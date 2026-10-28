'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** SQL da aprovação de conteúdo (marketing.content_items, content_versions, publication_jobs e o template apontado pela versão). */
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

/** Trava o item (FOR UPDATE, sem JOIN) para que aprovar, agendar e invalidar não corram juntos. */
async function lockItem(itemId, transaction) {
  const [row] = await run(
    'SELECT id, status, current_version_id FROM marketing.content_items WHERE id = :itemId AND deleted_at IS NULL FOR UPDATE', { itemId }, transaction
  );
  return row || null;
}

async function findVersion(versionId, transaction) {
  const [row] = await run(
    `SELECT id, content_item_id, content_hash, template_id, template_version_no, approved_by, approved_at, approved_hash
       FROM marketing.content_versions WHERE id = :versionId AND deleted_at IS NULL`, { versionId }, transaction
  );
  return row || null;
}

async function lockVersion(versionId, transaction) {
  const [row] = await run(
    `SELECT id, content_item_id, content_hash, template_id, template_version_no, approved_by, approved_at, approved_hash
       FROM marketing.content_versions WHERE id = :versionId AND deleted_at IS NULL FOR UPDATE`, { versionId }, transaction
  );
  return row || null;
}

async function findTemplate(templateId, transaction) {
  const [row] = await run('SELECT id, version_no, content_hash FROM marketing.templates WHERE id = :templateId', { templateId }, transaction);
  return row || null;
}

async function setApprovedHash(versionId, approvedHash, actor, transaction) {
  await run('UPDATE marketing.content_versions SET approved_hash = :approvedHash, updated_by = :actor, updated_at = now() WHERE id = :versionId RETURNING id',
    { versionId, approvedHash, actor }, transaction);
}

/** Limpa a aprovação (quem, quando, hash) de todas as versões do item que ainda a têm; devolve quantas. */
async function clearApprovals(itemId, actor, transaction) {
  const rows = await run(
    `UPDATE marketing.content_versions SET approved_by = NULL, approved_at = NULL, approved_hash = NULL, updated_by = :actor, updated_at = now()
      WHERE content_item_id = :itemId AND (approved_hash IS NOT NULL OR approved_at IS NOT NULL OR approved_by IS NOT NULL) RETURNING id`,
    { itemId, actor }, transaction
  );
  return rows.length;
}

async function setItemPendingApproval(itemId, actor, transaction) {
  await run("UPDATE marketing.content_items SET status = 'PENDING_APPROVAL', updated_by = :actor, updated_at = now() WHERE id = :itemId RETURNING id",
    { itemId, actor }, transaction);
}

/** Cancela os jobs PENDING de qualquer versão do item (motivo APPROVAL_INVALIDATED). Job RUNNING não é mexido aqui. */
async function cancelPendingJobs(itemId, actor, transaction) {
  const rows = await run(
    `UPDATE marketing.publication_jobs SET status = 'CANCELLED', last_error_code = 'APPROVAL_INVALIDATED', updated_by = :actor, updated_at = now()
      WHERE status = 'PENDING' AND deleted_at IS NULL
        AND content_version_id IN (SELECT id FROM marketing.content_versions WHERE content_item_id = :itemId) RETURNING id`,
    { itemId, actor }, transaction
  );
  return rows.map((r) => r.id);
}

module.exports = { lockItem, findVersion, lockVersion, findTemplate, setApprovedHash, clearApprovals, setItemPendingApproval, cancelPendingJobs };
