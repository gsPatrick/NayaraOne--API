'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, Task } = require('../../../../../models');
const AppError = require('../../../../../utils/AppError');
const { createOnceByActionKey } = require('../../../../../utils/createOnceByActionKey');
const { createOpportunityTask } = require('../../../../crm/opportunityTasks.service');
const { registrarAuditoria } = require('../../../../../engines/audit/auditLog.service');
const ports = require('../runner.ports');
const { LEAD_PARAM_DEFAULTS, readLeadInt } = require('../../leadParams');
const { fillMarkers, variablesFor } = require('./fill');

const MINUTE = 60000;
const latestOpportunity = async (personId, companyId, transaction) => (await sequelize.query(
  'SELECT id FROM crm.opportunities WHERE company_id = :c AND person_id = :p AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1', { replacements: { c: companyId, p: personId }, transaction, type: QueryTypes.SELECT }
))[0];

/** Responsável vindo do evento (`assigneeFromEvent`: campo do payload, ex.: o responsável da pendência); sem ele vale o informado na ação ou o dono da automação. */
const assigneeFromEvent = (def, ctx) => (def.assigneeFromEvent && ctx.event && ctx.event.payload ? ctx.event.payload[def.assigneeFromEvent] : null);

/** Prazo da tarefa em minutos: o fixo da ação (`dueInMinutes`) ou o do parâmetro da empresa nomeado em `dueInMinutesParam` (só chaves `marketing.`), lido na hora. */
async function dueMinutesOf(def, tenant, transaction) {
  if (Number.isInteger(def.dueInMinutes)) return def.dueInMinutes;
  if (typeof def.dueInMinutesParam !== 'string' || !def.dueInMinutesParam.startsWith('marketing.')) return null;
  if (LEAD_PARAM_DEFAULTS[def.dueInMinutesParam] !== undefined) return readLeadInt(def.dueInMinutesParam, tenant, transaction); // parâmetro com padrão registrado (prazo do lead novo)
  const { getSetting } = require('../../../../settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega o runner
  const value = Number(await getSetting(def.dueInMinutesParam, tenant, transaction, null));
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * CREATE_TASK -> serviço de tarefas do CRM (a action_key vai na coluna action_key da tarefa). Com oportunidade da pessoa, a tarefa entra nela
 * (createOpportunityTask); sem, vira tarefa da pessoa em core.tasks pelo mesmo caminho idempotente. Responsável: o informado ou o dono da automação.
 */
async function createTask(ctx) {
  const { def, entry, subject, tenant, transaction } = ctx;
  const rawTitle = typeof def.title === 'string' ? def.title.trim() : '';
  if (!rawTitle) throw AppError.badRequest('Informe o título da tarefa.', 'MKT_ACTION_INVALID');
  const filled = fillMarkers(rawTitle, await variablesFor(ctx)); // `variablesProvider`: o título pode levar o nome e o imóvel; marcador sem valor sai em branco
  const title = filled.text.replace(/\{[a-z_][a-z0-9_]*\}/gi, '').replace(/\s+/g, ' ').trim();
  const dueInMinutes = await dueMinutesOf(def, tenant, transaction);
  const assignee = def.assigneeUserId || (def.assignee ? await ports.assigneeOf(def.assignee, { tenant, transaction, subject, event: ctx.event }) : null);
  const payload = {
    title, description: def.description || null, assignedToUserId: assignee || assigneeFromEvent(def, ctx) || ctx.flow.ownerUserId || null, priority: def.priority, actionKey: entry.action_key,
    dueAt: dueInMinutes === null ? null : new Date(ctx.now.getTime() + dueInMinutes * MINUTE),
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
