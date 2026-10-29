'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** Acesso a governance.dlp_policies (M9-D820). A RLS isola pela empresa da sessão; o filtro explícito por company_id vale de qualquer forma. */
const COLUMNS = `classification, action, allowed, require_permission AS "requirePermission", require_justification AS "requireJustification",
  require_mfa AS "requireMfa", require_audit AS "requireAudit", require_watermark AS "requireWatermark", require_mask AS "requireMask",
  max_rows AS "maxRows", max_expiry_hours AS "maxExpiryHours", updated_by AS "updatedBy", updated_at AS "updatedAt"`;
const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

const ORDER = `ORDER BY array_position(ARRAY['LOW','MEDIUM','HIGH','RESTRICTED'], classification),
  array_position(ARRAY['VIEW','COPY','EXPORT','PRINT','SHARE','AI'], action)`;

const list = (companyId, transaction) => select(`SELECT ${COLUMNS} FROM governance.dlp_policies WHERE company_id = :companyId ${ORDER}`, { companyId }, transaction);

async function find(companyId, classification, action, transaction, { lock = false } = {}) {
  const rows = await select(
    `SELECT ${COLUMNS} FROM governance.dlp_policies WHERE company_id = :companyId AND classification = :classification AND action = :action${lock ? ' FOR UPDATE' : ''}`,
    { companyId, classification, action }, transaction
  );
  return rows[0] || null;
}

/** Semeia as linhas que faltam (idempotente, seguro com concorrência: ON CONFLICT DO NOTHING). */
async function insertMissing(tenant, rows, actorUserId, transaction) {
  for (const row of rows) {
    await sequelize.query(
      `INSERT INTO governance.dlp_policies (group_id, company_id, classification, action, allowed, require_permission, require_justification, require_mfa, require_audit,
         require_watermark, require_mask, max_rows, max_expiry_hours, updated_by)
       VALUES (:groupId, :companyId, :classification, :action, :allowed, :requirePermission, :requireJustification, :requireMfa, :requireAudit, :requireWatermark,
         :requireMask, :maxRows, :maxExpiryHours, :actorUserId)
       ON CONFLICT (company_id, classification, action) DO NOTHING`,
      { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actorUserId || null, ...row } }
    );
  }
}

async function update(companyId, classification, action, next, actorUserId, transaction) {
  await sequelize.query(
    `UPDATE governance.dlp_policies SET allowed = :allowed, require_permission = :requirePermission, require_justification = :requireJustification,
       require_mfa = :requireMfa, require_audit = :requireAudit, require_watermark = :requireWatermark, require_mask = :requireMask, max_rows = :maxRows,
       max_expiry_hours = :maxExpiryHours, updated_by = :actorUserId, updated_at = now()
     WHERE company_id = :companyId AND classification = :classification AND action = :action`,
    { transaction, replacements: { companyId, classification, action, actorUserId: actorUserId || null, ...next } }
  );
}

module.exports = { list, find, insertMissing, update };
