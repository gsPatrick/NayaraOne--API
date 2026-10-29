'use strict';

/**
 * M9-D692 — o que acontece na ABERTURA da instância, na MESMA transação do INSERT (sob o savepoint do motor): destinatários do owner (com reserva),
 * tarefa para CRITICAL com `create_task` (id em alert_instances.task_id) e aviso aos destinatários. Qualquer falha aqui desfaz a abertura inteira
 * (a instância não fica órfã de tarefa). Repetição e supressão não passam por aqui, por isso não criam outra tarefa nem outro aviso.
 */
const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const logger = require('../../../utils/logger');
const { resolveOwnerRecipients } = require('./owner.resolve');
const { createAlertTask } = require('./taskFactory.service');
const { notifyAlertOpened } = require('./notify.service');
const { emitAlertEvent, TYPES } = require('./events');

const linkOf = (params, instanceId) => `${params.panelLink}?alerta=${instanceId}`;

async function recordFallback({ def, instance, scope, recipients }, transaction) {
  logger.warn({ event: TYPES.OWNER_FALLBACK, alertCode: def.alert_code, instanceId: instance.id, reason: recipients.reason, fallbackRole: recipients.fallbackRole }, '[analytics] owner do alerta sem ninguém ativo: usando o reserva');
  await registrarAuditoria({
    groupId: scope.groupId, companyId: scope.companyId, actorUserId: null, action: TYPES.OWNER_FALLBACK, entityType: 'analytics.alert_instance', entityId: instance.id,
    beforeJson: { ownerUserId: def.owner_user_id || null, ownerRole: def.owner_role || null },
    afterJson: { fallbackRole: recipients.fallbackRole, recipients: recipients.userIds.length, reason: recipients.reason },
    reason: `Owner do alerta ${def.alert_code} sem usuário ativo (${recipients.reason}); reserva: ${recipients.fallbackRole}`,
  }, transaction);
  emitAlertEvent(transaction, {
    type: TYPES.OWNER_FALLBACK, instanceId: instance.id, alertCode: def.alert_code, metricCode: instance.metric_code || def.metric_code, severity: instance.severity,
    companyId: scope.companyId, groupId: scope.groupId, reason: recipients.reason, fallbackRole: recipients.fallbackRole,
  });
}

/** Devolve a instância com `task_id` preenchido quando a tarefa foi criada. */
async function applyOpenEffects({ def, scope, params, now }, instance, transaction) {
  const recipients = await resolveOwnerRecipients(def, scope, params, transaction);
  if (recipients.fallback) await recordFallback({ def, instance, scope, recipients }, transaction);
  const link = linkOf(params, instance.id);
  let row = instance;
  if (def.create_task === true && instance.severity === 'CRITICAL') {
    const ownerLabel = def.owner_user_id ? `usuário ${def.owner_user_id}` : `papel ${def.owner_role}`;
    const task = await createAlertTask({ def, instance, scope, assigneeId: recipients.userIds[0] || null, ownerLabel: recipients.fallback ? `${ownerLabel} (reserva: ${recipients.fallbackRole})` : ownerLabel, link, params, now }, transaction);
    [[row]] = await sequelize.query('UPDATE analytics.alert_instances SET task_id = :taskId, updated_at = now() WHERE id = :id RETURNING *', { replacements: { taskId: task.id, id: instance.id }, transaction });
  }
  await notifyAlertOpened({ def, instance: row, scope, link, userIds: recipients.userIds }, transaction);
  return row;
}

module.exports = { applyOpenEffects, linkOf };
