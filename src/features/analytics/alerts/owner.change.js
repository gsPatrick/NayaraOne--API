'use strict';

/**
 * M9-D692 (3.2) — mudar o owner de uma definição de alerta. Todo alerta continua com owner (usuário OU papel); a troca é auditada com antes e
 * depois (`analytics.alert.owner_change`). Escrita do worker/da rota administrativa (`analytics:alert:manage`).
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { assertWriter } = require('../analyticsStoreSupport');
const { MSG, runAlert } = require('../alertErrors');

async function changeAlertOwner(definitionId, { ownerUserId = null, ownerRole = null } = {}, ctx, transaction) {
  await assertWriter(transaction);
  const role = typeof ownerRole === 'string' ? ownerRole.trim() : '';
  if (!ownerUserId && !role) throw AppError.unprocessable(MSG.OWNER_REQUIRED, 'ANALYTICS_ALERT_OWNER_REQUIRED');
  return runAlert(async () => {
    const [rows] = await sequelize.query('SELECT * FROM analytics.alert_definitions WHERE id = :id FOR UPDATE', { replacements: { id: definitionId }, transaction });
    const current = rows[0];
    if (!current) throw AppError.notFound('Definição de alerta não encontrada.', 'ANALYTICS_ALERT_NOT_FOUND');
    const [[row]] = await sequelize.query(
      'UPDATE analytics.alert_definitions SET owner_user_id = :user, owner_role = :role, updated_by = :actor, updated_at = now() WHERE id = :id RETURNING *',
      { replacements: { id: definitionId, user: ownerUserId || null, role: role || null, actor: ctx?.actorUserId || null }, transaction }
    );
    await registrarAuditoria({
      groupId: current.group_id, companyId: current.company_id, actorUserId: ctx?.actorUserId || null, action: 'analytics.alert.owner_change', entityType: 'analytics.alert_definition',
      entityId: definitionId, beforeJson: { ownerUserId: current.owner_user_id, ownerRole: current.owner_role }, afterJson: { ownerUserId: row.owner_user_id, ownerRole: row.owner_role },
      reason: `Owner do alerta ${current.alert_code} alterado`,
    }, transaction);
    return row;
  });
}

module.exports = { changeAlertOwner };
