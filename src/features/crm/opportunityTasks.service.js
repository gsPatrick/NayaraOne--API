'use strict';

const { Task, Opportunity, User } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * M3-11 — Tarefas no ciclo de vida da Oportunidade.
 *
 * "core"."tasks" já existia (tabela polimórfica, com RLS real — ver
 * migrations/20260101000009-create-core-tasks.js) mas só era usada por legal/billing: o CRM
 * não tinha nenhum caminho para registrar "o que precisa ser feito" numa oportunidade além do
 * campo único `next_action` (texto livre, uma ação só, sem responsável e sem histórico).
 *
 * DECISÃO DE ENGENHARIA: não criamos uma tabela nova `crm.opportunity_tasks`. A tarefa de CRM
 * é a MESMA entidade operacional do resto do sistema, ligada por
 * `related_entity_type = 'crm.opportunities'` + `related_entity_id = <opportunity.id>` —
 * assim a caixa de tarefas do usuário é única (uma consulta só em core.tasks devolve tarefas
 * de contrato, de cobrança e de oportunidade) e o RLS/auditoria já existentes valem de graça.
 *
 * `next_action` continua sendo a PRÓXIMA ação obrigatória do funil (regra do M3-10, validada
 * em opportunityNextAction.validator.js); as tarefas são o plano de trabalho ao redor dela.
 */

const RELATED_ENTITY_TYPE = 'crm.opportunities';
const STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

async function createOpportunityTask(opportunityId, payload, actorUserId, transaction) {
  if (!opportunityId) {
    throw AppError.badRequest('O campo "opportunityId" é obrigatório.', 'OPPORTUNITY_TASK_VALIDATION');
  }

  // Busca a oportunidade DENTRO do contexto de tenant (RLS): se o id for de outra empresa, a
  // linha simplesmente não existe para esta sessão e a criação morre aqui com 404 — não há
  // como pendurar uma tarefa desta empresa numa oportunidade de outra.
  const opportunity = await Opportunity.findByPk(opportunityId, { transaction });
  if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');

  const { title, description, assignedToUserId, dueAt, status, priority } = payload || {};

  if (!title || !String(title).trim()) {
    throw AppError.badRequest('O campo "title" é obrigatório.', 'OPPORTUNITY_TASK_VALIDATION');
  }

  const normalizedStatus = status ? String(status).toUpperCase() : 'OPEN';
  if (!STATUSES.includes(normalizedStatus)) {
    throw AppError.badRequest(`O campo "status" deve ser um de: ${STATUSES.join(', ')}.`, 'OPPORTUNITY_TASK_VALIDATION');
  }
  const normalizedPriority = priority ? String(priority).toUpperCase() : 'NORMAL';
  if (!PRIORITIES.includes(normalizedPriority)) {
    throw AppError.badRequest(
      `O campo "priority" deve ser um de: ${PRIORITIES.join(', ')}.`,
      'OPPORTUNITY_TASK_VALIDATION'
    );
  }

  if (assignedToUserId) {
    const assignee = await User.findByPk(assignedToUserId, { transaction });
    if (!assignee) throw AppError.notFound('Usuário responsável pela tarefa não encontrado.', 'USER_NOT_FOUND');
    if (assignee.status && String(assignee.status).toUpperCase() !== 'ACTIVE') {
      throw AppError.unprocessable(
        'Não é possível atribuir uma tarefa a um usuário que não está ativo.',
        'OPPORTUNITY_TASK_ASSIGNEE_NOT_ACTIVE',
        { assignedToUserId, status: assignee.status }
      );
    }
  }

  const task = await Task.create(
    {
      groupId: opportunity.groupId,
      companyId: opportunity.companyId,
      assignedToUserId: assignedToUserId || null,
      title: String(title).trim(),
      description: description || null,
      relatedEntityType: RELATED_ENTITY_TYPE,
      relatedEntityId: opportunity.id,
      dueAt: dueAt || null,
      status: normalizedStatus,
      priority: normalizedPriority,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: opportunity.groupId,
      companyId: opportunity.companyId,
      actorUserId,
      action: 'opportunity.task_create',
      entityType: 'Task',
      entityId: task.id,
      afterJson: task.toJSON(),
      reason: `Tarefa "${task.title}" criada na oportunidade ${opportunity.id}.`,
    },
    transaction
  );

  return task;
}

async function listOpportunityTasks(opportunityId, transaction, filters = {}) {
  if (!opportunityId) {
    throw AppError.badRequest('O campo "opportunityId" é obrigatório.', 'OPPORTUNITY_TASK_VALIDATION');
  }
  const opportunity = await Opportunity.findByPk(opportunityId, { transaction });
  if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');

  const where = { relatedEntityType: RELATED_ENTITY_TYPE, relatedEntityId: opportunityId };
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.assignedToUserId) where.assignedToUserId = filters.assignedToUserId;

  return Task.findAll({
    where,
    order: [
      ['due_at', 'ASC'],
      ['created_at', 'ASC'],
    ],
    transaction,
  });
}

module.exports = {
  RELATED_ENTITY_TYPE,
  STATUSES,
  PRIORITIES,
  createOpportunityTask,
  listOpportunityTasks,
};
