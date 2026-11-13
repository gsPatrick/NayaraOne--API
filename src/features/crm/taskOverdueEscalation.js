'use strict';

const { Op, literal } = require('sequelize');
const { sequelize, Task, Opportunity, Notification } = require('../../models');
const { publishDomainEvent } = require('../../engines/events/outbox');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { CLOSED_STAGE_CODES } = require('./opportunityStages');
const { readTaskManagerAfterHours } = require('./crm.params');
const { managerUserIds } = require('./crmUsers');

/**
 * Livro do Marco 3 §11 "Tarefa vencida escala conforme regra" (CAD-11) e evento mínimo `crm.task.overdue` (§17). Regra (DI-M3CA-5):
 *  1º nível — a tarefa venceu: avisa o responsável da tarefa e o responsável da oportunidade; evento crm.task.overdue.
 *  2º nível — continua aberta depois de `crm.tarefa_vencida.escalar_gerencia_apos_horas` (padrão 24; 0 = junto com o 1º nível):
 *            avisa a gerência (permissão de `crm.gerencia.permissao`); evento crm.task.escalated.
 * Só tarefa de oportunidade em aberto escala: a de oportunidade ganha (WON), perdida (LOST) ou excluída fica de fora (Guia §8:
 * a perda cancela as tarefas; a ganha não tem mais o que cobrar no funil). Cada nível é marcado no audit_log por tarefa e por
 * vencimento (`dueAt`): repetir o job não reavisa; tarefa reagendada que vence de novo escala de novo. Cada tarefa roda em
 * savepoint próprio (PADRAO_COMPONENTES 2.6).
 */
const RELATED_ENTITY_TYPE = 'crm.opportunities';
const ESCALATABLE_STATUSES = ['OPEN', 'IN_PROGRESS'];
const LEVEL_ACTIONS = Object.freeze({ owner: 'crm.task.job_escalation', management: 'crm.task.job_escalation_management' });

const dueKey = (task) => new Date(task.dueAt).toISOString();

async function escalationMarks(taskIds, transaction) {
  if (taskIds.length === 0) return new Set();
  const [rows] = await sequelize.query(
    `SELECT action, entity_id, after_json->>'dueAt' AS due_at FROM audit.audit_log
      WHERE action IN (:actions) AND entity_type = 'Task' AND entity_id IN (:taskIds)`,
    { replacements: { taskIds, actions: Object.values(LEVEL_ACTIONS) }, transaction }
  );
  return new Set(rows.map((r) => `${r.action}|${r.entity_id}|${r.due_at ? new Date(r.due_at).toISOString() : ''}`));
}

async function notifyAll(task, userIds, title, body, transaction) {
  for (const userId of userIds) {
    await Notification.create(
      { groupId: task.groupId, companyId: task.companyId, userId, channel: 'IN_APP', title, body, createdBy: null, updatedBy: null },
      { transaction }
    );
  }
}

async function escalateLevel(task, level, notifiedUserIds, transaction) {
  const management = level === 'management';
  await publishDomainEvent(
    {
      groupId: task.groupId,
      companyId: task.companyId,
      aggregateType: 'Task',
      aggregateId: task.id,
      eventType: management ? 'crm.task.escalated' : 'crm.task.overdue',
      payload: { id: task.id, opportunityId: task.relatedEntityId, title: task.title, dueAt: task.dueAt, level, notifiedUserIds },
      idempotencyKey: `${management ? 'crm.task.escalated' : 'crm.task.overdue'}:${task.id}:${dueKey(task)}`,
    },
    transaction
  );
  await registrarAuditoria(
    {
      groupId: task.groupId,
      companyId: task.companyId,
      actorUserId: null,
      action: LEVEL_ACTIONS[level],
      entityType: 'Task',
      entityId: task.id,
      afterJson: { dueAt: dueKey(task), level, notifiedUserIds },
      reason: management
        ? `Tarefa de CRM "${task.title}" (oportunidade ${task.relatedEntityId}) segue vencida: escalonada para a gerência (${notifiedUserIds.length} gestor(es)).`
        : `Tarefa de CRM "${task.title}" (oportunidade ${task.relatedEntityId}) vencida: aviso ao responsável e ao dono da oportunidade.`,
    },
    transaction
  );
}

async function escalateOverdueCrmTasks(transaction, now = new Date()) {
  const overdue = await Task.findAll({
    where: {
      relatedEntityType: RELATED_ENTITY_TYPE,
      status: { [Op.in]: ESCALATABLE_STATUSES },
      dueAt: { [Op.ne]: null, [Op.lt]: now },
      relatedEntityId: {
        [Op.in]: literal(`(SELECT id FROM crm.opportunities WHERE deleted_at IS NULL AND stage NOT IN (${CLOSED_STAGE_CODES.map((s) => sequelize.escape(s)).join(', ')}))`),
      },
    },
    order: [['due_at', 'ASC'], ['id', 'ASC']],
    transaction,
  });
  const summary = { tasksChecked: overdue.length, escalated: 0, escalatedToManagement: 0 };
  if (overdue.length === 0) return summary;

  const tenant = { groupId: overdue[0].groupId, companyId: overdue[0].companyId };
  const afterHours = await readTaskManagerAfterHours(tenant, transaction);
  const managers = await managerUserIds(tenant, transaction);
  const marks = await escalationMarks(overdue.map((t) => t.id), transaction);

  for (const task of overdue) {
    await sequelize.transaction({ transaction }, async (savepoint) => {
      const due = new Date(task.dueAt);
      const when = due.toLocaleString('pt-BR');
      if (!marks.has(`${LEVEL_ACTIONS.owner}|${task.id}|${dueKey(task)}`)) {
        const opportunity = await Opportunity.findByPk(task.relatedEntityId, { transaction: savepoint });
        const owners = [...new Set([task.assignedToUserId, opportunity && opportunity.ownerUserId].filter(Boolean))];
        await notifyAll(task, owners, 'Tarefa de CRM vencida', `"${task.title}" venceu em ${when} e ainda não foi concluída.`, savepoint);
        await escalateLevel(task, 'owner', owners, savepoint);
        summary.escalated += 1;
      }
      const reachedManagement = now.getTime() - due.getTime() >= afterHours * 3600 * 1000;
      if (reachedManagement && !marks.has(`${LEVEL_ACTIONS.management}|${task.id}|${dueKey(task)}`)) {
        await notifyAll(task, managers, 'Tarefa de CRM vencida escalada para a gerência', `"${task.title}" venceu em ${when} e segue sem conclusão há mais de ${afterHours} hora(s).`, savepoint);
        await escalateLevel(task, 'management', managers, savepoint);
        summary.escalatedToManagement += 1;
      }
    });
  }
  return summary;
}

module.exports = { escalateOverdueCrmTasks, LEVEL_ACTIONS, ESCALATABLE_STATUSES };
