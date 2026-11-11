'use strict';

const { Op } = require('sequelize');
const { Task } = require('../../models');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishTaskChange } = require('./crmCalendarEvents.service');

/**
 * Guia do Marco 3 §8 markLost: `tasks.cancelFuture(tx, opportunityId)` na mesma transação que marca LOST. "Futuras" = toda tarefa
 * da oportunidade que ainda não foi feita (OPEN ou IN_PROGRESS), vencida ou não: depois da perda ninguém vai executá-la e a vencida
 * escalaria à toa (DI-M3CA-4). Concluída e cancelada não mudam. Cada tarefa cancelada fica no audit_log com antes/depois e fecha o
 * item do Calendário (crm.task.cancelled).
 */
const RELATED_ENTITY_TYPE = 'crm.opportunities';
const PENDING_STATUSES = Object.freeze(['OPEN', 'IN_PROGRESS']);

async function cancelPendingTasks(opportunity, actorUserId, transaction, reason) {
  const tasks = await Task.findAll({
    where: { relatedEntityType: RELATED_ENTITY_TYPE, relatedEntityId: opportunity.id, status: { [Op.in]: PENDING_STATUSES } },
    order: [['id', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  for (const task of tasks) {
    const beforeJson = task.toJSON();
    const before = task.status;
    task.status = 'CANCELED';
    task.updatedBy = actorUserId || null;
    await task.save({ transaction });
    await registrarAuditoria(
      {
        groupId: task.groupId,
        companyId: task.companyId,
        actorUserId,
        action: 'opportunity.task_cancel_on_lost',
        entityType: 'Task',
        entityId: task.id,
        beforeJson,
        afterJson: task.toJSON(),
        reason: `Tarefa "${task.title}" cancelada porque a oportunidade ${opportunity.id} foi marcada como perdida (${reason}).`,
      },
      transaction
    );
    await publishTaskChange(task, before, transaction);
  }
  return tasks.map((t) => t.id);
}

module.exports = { cancelPendingTasks, PENDING_STATUSES };
