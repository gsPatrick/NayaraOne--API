'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** SQL da definição de automações (M9-D413). RLS por grupo e empresa vale na transação do chamador. */
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

const FLOW_COLUMNS = 'id, code, name, owner_user_id, risk_level, status, published_version_id';
const VERSION_COLUMNS = `id, flow_id, version_no, trigger_type, trigger_config, conditions, conditions_empty_reason, actions, cooldown,
  frequency_cap, valid_from, valid_until, status, risk_level, content_hash`;

/** Trava o fluxo (FOR UPDATE, sem JOIN): publicar, pausar e criar versão do mesmo fluxo se enfileiram aqui. */
async function lockFlow(flowId, transaction) {
  const [row] = await run(`SELECT ${FLOW_COLUMNS} FROM marketing.automation_flows WHERE id = :flowId AND deleted_at IS NULL FOR UPDATE`, { flowId }, transaction);
  return row || null;
}

async function findFlowByCode(code, transaction) {
  const [row] = await run(`SELECT ${FLOW_COLUMNS} FROM marketing.automation_flows WHERE code = :code AND deleted_at IS NULL`, { code }, transaction);
  return row || null;
}

async function insertFlow(tenant, actor, v, transaction) {
  const [row] = await run(
    `INSERT INTO marketing.automation_flows (id, group_id, company_id, code, name, owner_user_id, risk_level, status, created_by, updated_by)
     VALUES (gen_random_uuid(), :groupId, :companyId, :code, :name, :owner, :risk, 'PAUSED', :actor, :actor) RETURNING ${FLOW_COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, code: v.code, name: v.name, owner: v.ownerUserId, risk: v.riskLevel, actor: actor || null }, transaction
  );
  return row;
}

async function updateFlow(flowId, patch, actor, transaction) {
  const [row] = await run(
    `UPDATE marketing.automation_flows SET owner_user_id = COALESCE(:owner, owner_user_id), risk_level = COALESCE(:risk, risk_level),
        status = COALESCE(:status, status), published_version_id = CASE WHEN :setPublished THEN :publishedId ELSE published_version_id END,
        updated_by = :actor, updated_at = now() WHERE id = :flowId RETURNING ${FLOW_COLUMNS}`,
    { flowId, owner: patch.ownerUserId || null, risk: patch.riskLevel || null, status: patch.status || null,
      setPublished: patch.publishedVersionId !== undefined, publishedId: patch.publishedVersionId || null, actor: actor || null }, transaction
  );
  return row;
}

async function latestVersion(flowId, transaction) {
  const [row] = await run(`SELECT ${VERSION_COLUMNS} FROM marketing.automation_versions WHERE flow_id = :flowId AND deleted_at IS NULL ORDER BY version_no DESC LIMIT 1`, { flowId }, transaction);
  return row || null;
}

async function lockVersionByNo(flowId, versionNo, transaction) {
  const [row] = await run(
    `SELECT ${VERSION_COLUMNS} FROM marketing.automation_versions WHERE flow_id = :flowId AND version_no = :versionNo AND deleted_at IS NULL FOR UPDATE`,
    { flowId, versionNo }, transaction
  );
  return row || null;
}

async function liveVersion(flowId, transaction) {
  const [row] = await run(
    `SELECT ${VERSION_COLUMNS} FROM marketing.automation_versions WHERE flow_id = :flowId AND status IN ('PUBLISHED','PAUSED') AND deleted_at IS NULL FOR UPDATE`,
    { flowId }, transaction
  );
  return row || null;
}

async function insertVersion(tenant, actor, flowId, versionNo, d, contentHash, transaction) {
  const [row] = await run(
    `INSERT INTO marketing.automation_versions (id, group_id, company_id, flow_id, version_no, trigger_type, trigger_config, conditions,
        conditions_empty_reason, actions, cooldown, frequency_cap, valid_from, valid_until, status, risk_level, content_hash, created_by, updated_by)
     VALUES (gen_random_uuid(), :groupId, :companyId, :flowId, :versionNo, :triggerType, CAST(:triggerConfig AS jsonb), CAST(:conditions AS jsonb),
        :emptyReason, CAST(:actions AS jsonb), CAST(:cooldown AS jsonb), CAST(:frequencyCap AS jsonb), :validFrom, :validUntil, 'DRAFT', :riskLevel,
        :contentHash, :actor, :actor) RETURNING ${VERSION_COLUMNS}`,
    {
      groupId: tenant.groupId, companyId: tenant.companyId, flowId, versionNo, triggerType: d.triggerType,
      triggerConfig: JSON.stringify(d.triggerConfig), conditions: JSON.stringify(d.conditions), emptyReason: d.conditionsEmptyReason || null,
      actions: JSON.stringify(d.actions), cooldown: JSON.stringify(d.cooldown), frequencyCap: JSON.stringify(d.frequencyCap),
      validFrom: d.validFrom || null, validUntil: d.validUntil || null, riskLevel: d.riskLevel, contentHash, actor: actor || null,
    },
    transaction
  );
  return row;
}

async function setVersionStatus(versionId, status, actor, transaction) {
  const [row] = await run(
    `UPDATE marketing.automation_versions SET status = :status, updated_by = :actor, updated_at = now() WHERE id = :versionId RETURNING ${VERSION_COLUMNS}`,
    { versionId, status, actor: actor || null }, transaction
  );
  return row;
}

/** Usuário ativo (status ACTIVE) com vínculo ativo na empresa: o dono da automação (MKT-006). */
async function ownerIsActive(userId, tenant, transaction) {
  const rows = await run(
    `SELECT 1 FROM core.users u JOIN core.user_memberships m ON m.user_id = u.id
      WHERE u.id = :userId AND u.status = 'ACTIVE' AND u.deleted_at IS NULL AND m.company_id = :companyId AND m.status = 'ACTIVE' AND m.deleted_at IS NULL LIMIT 1`,
    { userId, companyId: tenant.companyId }, transaction
  );
  return rows.length > 0;
}

async function listVersions(flowId, transaction) {
  return run(`SELECT ${VERSION_COLUMNS} FROM marketing.automation_versions WHERE flow_id = :flowId AND deleted_at IS NULL ORDER BY version_no`, { flowId }, transaction);
}

module.exports = {
  lockFlow, findFlowByCode, insertFlow, updateFlow, latestVersion, lockVersionByNo, liveVersion, insertVersion, setVersionStatus, ownerIsActive, listVersions,
};
