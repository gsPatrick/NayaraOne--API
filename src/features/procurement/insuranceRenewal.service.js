'use strict';

const { InsuranceRenewalTask, InsurancePolicy } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishRenewalCompleted } = require('./insuranceCalendarEvents.service');

/** M9-D802 — conclui a tarefa de renovação da apólice (renovação tratada). O Calendário fecha o item pelo evento desta operação. */
async function completeRenewalTask(taskId, actor, transaction) {
  const task = await InsuranceRenewalTask.findOne({ where: { id: taskId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!task) throw AppError.notFound('Tarefa de renovação não encontrada.', 'INSURANCE_RENEWAL_TASK_NOT_FOUND');
  if (task.status !== 'PENDING') {
    throw AppError.conflict(`Só uma tarefa de renovação pendente pode ser concluída (atual: ${task.status}).`, 'INSURANCE_RENEWAL_TASK_INVALID_STATE');
  }
  const beforeJson = task.toJSON();
  task.status = 'DONE';
  await task.save({ transaction });
  const policy = await InsurancePolicy.findByPk(task.policyId, { transaction });
  await registrarAuditoria({
    groupId: task.groupId, companyId: task.companyId, actorUserId: actor.userId, action: 'procurement.insurance_renewal_task.complete',
    entityType: 'InsuranceRenewalTask', entityId: task.id, beforeJson, afterJson: task.toJSON(), reason: 'Renovação da apólice tratada.',
  }, transaction);
  await publishRenewalCompleted(task, policy, transaction);
  return task;
}

module.exports = { completeRenewalTask };
