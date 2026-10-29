'use strict';

const { sequelize, Notification } = require('../../../models');
const { CHANNEL_IN_APP } = require('../calendar/alerts/alerts.constants');
const { ADMIN_PERMISSION } = require('./dlp.constants');

/** Usuários ativos da empresa com uma permissão pelos perfis. */
async function usersWithPermission(tenant, code, transaction) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT m.user_id AS "userId" FROM core.user_memberships m
       JOIN core.role_permissions rp ON rp.role_id = m.role_id JOIN core.permissions p ON p.id = rp.permission_id
      WHERE m.company_id = :companyId AND m.status = 'ACTIVE' AND m.deleted_at IS NULL AND p.code = :code`,
    { replacements: { companyId: tenant.companyId, code }, transaction }
  );
  return rows.map((row) => row.userId);
}

/** Aviso IN_APP a quem tem `governance:dlp:admin` (M9-D824 §3.3 item 1). Devolve quantos avisos criou. */
async function notifyDlpAdmins(tenant, title, body, transaction) {
  const admins = await usersWithPermission(tenant, ADMIN_PERMISSION, transaction);
  for (const userId of admins) {
    await Notification.create({ groupId: tenant.groupId, companyId: tenant.companyId, userId, channel: CHANNEL_IN_APP, title, body, createdBy: null, updatedBy: null }, { transaction });
  }
  return admins.length;
}

module.exports = { notifyDlpAdmins, usersWithPermission };
