'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const q = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const COLUMNS = `id, code, name, retention_months, "trigger", legal_basis_code, legal_basis_text, reference_text, disposition, exceptions, data_types, owner_domain, version,
  approved_by, approved_at, auto_apply, is_seed, created_at, updated_at`;

/** Linha do banco -> política no formato da API. */
function present(row) {
  return {
    id: row.id, code: row.code, name: row.name, retentionMonths: row.retention_months, trigger: row.trigger,
    legalBasis: { code: row.legal_basis_code, text: row.legal_basis_text, referenceText: row.reference_text },
    disposition: row.disposition, exceptions: row.exceptions, dataTypes: row.data_types, ownerDomain: row.owner_domain, version: row.version,
    approvedBy: row.approved_by, approvedAt: row.approved_at, autoApply: row.auto_apply, isSeed: row.is_seed, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function list(tenant, transaction, { forUpdate = false } = {}) {
  const rows = await q(`SELECT ${COLUMNS} FROM governance.retention_policies WHERE company_id = :companyId ORDER BY code ${forUpdate ? 'FOR UPDATE' : ''}`, { companyId: tenant.companyId }, transaction);
  return rows.map(present);
}

async function findByCode(tenant, code, transaction, { forUpdate = false } = {}) {
  const rows = await q(`SELECT ${COLUMNS} FROM governance.retention_policies WHERE company_id = :companyId AND code = :code ${forUpdate ? 'FOR UPDATE' : ''}`, { companyId: tenant.companyId, code }, transaction);
  return rows[0] ? present(rows[0]) : null;
}

const params = (tenant, policy, actorUserId) => ({
  groupId: tenant.groupId, companyId: tenant.companyId, code: policy.code, name: policy.name, months: policy.retentionMonths, trigger: policy.trigger, basisCode: policy.legalBasis.code,
  basisText: policy.legalBasis.text, referenceText: policy.legalBasis.referenceText, disposition: policy.disposition, exceptions: JSON.stringify(policy.exceptions),
  dataTypes: JSON.stringify(policy.dataTypes), ownerDomain: policy.ownerDomain, autoApply: Boolean(policy.autoApply), actorUserId: actorUserId || null,
});

/** Semeia (idempotente: ON CONFLICT DO NOTHING) as políticas iniciais da empresa. */
async function insertSeed(tenant, policy, transaction) {
  await q(
    `INSERT INTO governance.retention_policies (group_id, company_id, code, name, retention_months, "trigger", legal_basis_code, legal_basis_text, reference_text, disposition, exceptions, data_types, owner_domain, auto_apply, is_seed)
     VALUES (:groupId, :companyId, :code, :name, :months, :trigger, :basisCode, :basisText, :referenceText, :disposition, CAST(:exceptions AS jsonb), CAST(:dataTypes AS jsonb), :ownerDomain, :autoApply, true)
     ON CONFLICT (company_id, code) DO NOTHING RETURNING id`,
    params(tenant, policy), transaction
  );
}

async function insert(tenant, policy, actorUserId, transaction) {
  const rows = await q(
    `INSERT INTO governance.retention_policies (group_id, company_id, code, name, retention_months, "trigger", legal_basis_code, legal_basis_text, reference_text, disposition, exceptions, data_types, owner_domain, auto_apply, approved_by, approved_at)
     VALUES (:groupId, :companyId, :code, :name, :months, :trigger, :basisCode, :basisText, :referenceText, :disposition, CAST(:exceptions AS jsonb), CAST(:dataTypes AS jsonb), :ownerDomain, :autoApply, :actorUserId, now())
     RETURNING ${COLUMNS}`,
    params(tenant, policy, actorUserId), transaction
  );
  return present(rows[0]);
}

async function update(tenant, policy, actorUserId, transaction) {
  const rows = await q(
    `UPDATE governance.retention_policies SET name = :name, retention_months = :months, "trigger" = :trigger, legal_basis_code = :basisCode, legal_basis_text = :basisText, reference_text = :referenceText,
       disposition = :disposition, exceptions = CAST(:exceptions AS jsonb), data_types = CAST(:dataTypes AS jsonb), owner_domain = :ownerDomain, auto_apply = :autoApply,
       version = version + 1, approved_by = :actorUserId, approved_at = now(), updated_at = now()
     WHERE company_id = :companyId AND code = :code RETURNING ${COLUMNS}`,
    params(tenant, policy, actorUserId), transaction
  );
  return present(rows[0]);
}

module.exports = { list, findByCode, insertSeed, insert, update, present };
