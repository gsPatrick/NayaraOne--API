'use strict';

const { dueFromDateValue } = require('./time');
const { lifecycle, ownerOf } = require('./lifecycle');

/** Fontes CRM_TASK e VISIT (M9-D802 §3.1.1). Sem tabela própria: o evento da origem carrega o necessário. */
const task = lifecycle('CRM_TASK', (p, ctx) => {
  const dueAt = dueFromDateValue(p.dueAt, { dateOnly: false });
  return dueAt && { title: p.title || 'Tarefa do CRM', dueAt, deepLink: `/painel/crm/tarefas/${p.id}`, ...ownerOf(p.assignedToUserId, 'CRM_TASK', ctx) };
});

const visit = lifecycle('VISIT', (p, ctx) => {
  const dueAt = dueFromDateValue(p.scheduledAt, { dateOnly: false });
  return dueAt && {
    title: p.propertyTitle ? `Visita: ${p.propertyTitle}` : 'Visita agendada',
    dueAt,
    endAt: new Date(dueAt.getTime() + (ctx.durationMin || 60) * 60000),
    deepLink: `/painel/crm/visitas/${p.id}`,
    ...ownerOf(p.agentUserId, 'VISIT', ctx),
  };
});

const EVENT_MAPPERS = {
  'crm.task.created': task.upsert,
  'crm.task.updated': task.upsert,
  'crm.task.completed': task.done,
  'crm.task.cancelled': task.cancelled,
  'crm.task.reopened': task.reopen,
  'crm.visit.scheduled': visit.upsert,
  'crm.visit.rescheduled': visit.upsert,
  'crm.visit.completed': visit.done,
  'crm.visit.cancelled': visit.cancelled,
};

module.exports = { EVENT_MAPPERS };
