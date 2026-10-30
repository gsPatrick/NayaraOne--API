'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, Task } = require('../../../../../models');
const AppError = require('../../../../../utils/AppError');
const { createOnceByActionKey } = require('../../../../../utils/createOnceByActionKey');
const { createOpportunityTask } = require('../../../../crm/opportunityTasks.service');
const { registrarAuditoria } = require('../../../../../engines/audit/auditLog.service');

const MINUTE = 60000;
const latestOpportunity = async (personId, companyId, transaction) => (await sequelize.query(
  'SELECT id FROM crm.opportunities WHERE company_id = :c AND person_id = :p AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1', { replacements: { c: companyId, p: personId }, transaction, type: QueryTypes.SELECT }
))[0];

/** Responsável vindo do evento (`assigneeFromEvent`: campo do payload, ex.: o responsável da pendência); sem ele vale o informado na ação ou o dono da automação. */
const assigneeFromEvent = (def, ctx) => (def.assigneeFromEvent && ctx.event && ctx.event.payload ? ctx.event.payload[def.assigneeFromEvent] : null);

/**
 * CREATE_TASK -> serviço de tarefas do CRM (a action_key vai na coluna action_key da tarefa). Com oportunidade da pessoa, a tarefa entra nela
 * (createOpportunityTask); sem, vira tarefa da pessoa em core.tasks pelo mesmo caminho idempotente. Responsável: o informado ou o dono da automação.
 */
async function createTask(ctx) {
  const { def, entry, subject, tenant, transaction } = ctx;
  const title = typeof def.title === 'string' ? def.title.trim() : '';
  if (!title) throw AppError.badRequest('Informe o título da tarefa.', 'MKT_ACTION_INVALID');
  const payload = {
    title, description: def.description || null, assignedToUserId: def.assigneeUserId || assigneeFromEvent(def, ctx) || ctx.flow.ownerUserId || null, priority: def.priority, actionKey: entry.action_key,
    dueAt: Number.isInteger(def.dueInMinutes) ? new Date(ctx.now.getTime() + def.dueInMinutes * MINUTE) : null,
  };
  const opportunity = subject ? await latestOpportunity(subject.id, tenant.companyId, transaction) : null;
  if (opportunity) {
    const task = await createOpportunityTask(opportunity.id, payload, ctx.flow.ownerUserId, transaction);
    return { status: 'OK', providerRef: task.id };
  }
  const { record, replay } = await createOnceByActionKey(Task, {
    groupId: tenant.groupId, companyId: tenant.companyId, assignedToUserId: payload.assignedToUserId, title, description: payload.description,
    relatedEntityType: subject ? 'people.persons' : 'marketing.automation_runs', relatedEntityId: subject ? subject.id : ctx.run.id, dueAt: payload.dueAt, status: 'OPEN',
    priority: payload.priority ? String(payload.priority).toUpperCase() : 'NORMAL', actionKey: entry.action_key, createdBy: ctx.flow.ownerUserId || null, updatedBy: ctx.flow.ownerUserId || null,
  }, { transaction });
  if (!replay) {
    await registrarAuditoria({ groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: ctx.flow.ownerUserId || null, action: 'marketing.automation.task_create', entityType: 'Task', entityId: record.id, afterJson: record.toJSON(), reason: `Tarefa "${title}" criada pela automação.` }, transaction);
  }
  return { status: 'OK', providerRef: record.id };
}

module.exports = { createTask };
