'use strict';

const { Op } = require('sequelize');
const { Message, Visit, Task, Proposal, AuditLog, Opportunity } = require('../../models');
const AppError = require('../../utils/AppError');
const { RELATED_ENTITY_TYPE: TASK_RELATED_ENTITY_TYPE } = require('./opportunityTasks.service');

/**
 * M3-19 — Timeline/interações omnichannel UNIFICADA de uma oportunidade.
 *
 * Até aqui cada fonte vivia isolada: mensagens (crm.messages), visitas (crm.visits),
 * propostas (crm.proposals), tarefas (core.tasks) e as mudanças de estágio (registradas em
 * audit.audit_log pela action `opportunity.stage_change`). Quem atendia o cliente precisava
 * abrir quatro telas para reconstruir "o que aconteceu nesta negociação".
 *
 * DECISÃO DE ENGENHARIA: a timeline é DERIVADA na leitura, não uma tabela nova de eventos.
 * Não existe estado a manter, nada a sincronizar e nenhum risco de a timeline divergir das
 * entidades — as próprias tabelas de origem continuam sendo a única fonte da verdade. Como
 * tudo é lido na MESMA transação de tenant, o RLS de cada tabela de origem vale igual: uma
 * oportunidade de outra empresa nem sequer é encontrada (404).
 *
 * As mudanças de estágio vêm de audit.audit_log (e não do outbox) porque a auditoria é o
 * registro permanente e append-only do que aconteceu — o outbox é uma fila de entrega e seus
 * eventos podem ser podados depois de despachados.
 */

const TYPES = {
  MESSAGE: 'MESSAGE',
  VISIT: 'VISIT',
  STAGE_CHANGE: 'STAGE_CHANGE',
  PROPOSAL: 'PROPOSAL',
  TASK: 'TASK',
  OPPORTUNITY_CREATED: 'OPPORTUNITY_CREATED',
};

/** Ações de auditoria da própria Opportunity que viram item de timeline. */
const AUDIT_ACTION_TO_TYPE = {
  'opportunity.stage_change': TYPES.STAGE_CHANGE,
  'opportunity.create': TYPES.OPPORTUNITY_CREATED,
};

/**
 * Vários models do sistema declaram `createdAt: 'created_at'`, o que RENOMEIA o atributo —
 * `record.createdAt` é `undefined` neles e o valor só existe em `record.get('created_at')`.
 * Ler os dois nomes é o que evita a timeline posicionar um item em 1970 por acidente.
 */
function createdAtOf(record) {
  return record.createdAt || record.get('created_at') || null;
}

function toTime(value) {
  return value ? new Date(value).getTime() : 0;
}

async function getOpportunityTimeline(opportunityId, transaction, options = {}) {
  if (!opportunityId) {
    throw AppError.badRequest('O campo "opportunityId" é obrigatório.', 'OPPORTUNITY_TIMELINE_VALIDATION');
  }

  const opportunity = await Opportunity.findByPk(opportunityId, { transaction });
  if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');

  const [messages, visits, proposals, tasks, auditEntries] = await Promise.all([
    Message.findAll({ where: { opportunityId }, transaction }),
    Visit.findAll({ where: { opportunityId }, transaction }),
    Proposal.findAll({ where: { opportunityId }, transaction }),
    Task.findAll(
      {
        where: { relatedEntityType: TASK_RELATED_ENTITY_TYPE, relatedEntityId: opportunityId },
        transaction,
      }
    ),
    AuditLog.findAll({
      where: {
        entityType: 'Opportunity',
        entityId: opportunityId,
        action: { [Op.in]: Object.keys(AUDIT_ACTION_TO_TYPE) },
      },
      transaction,
    }),
  ]);

  const items = [];

  for (const message of messages) {
    items.push({
      type: TYPES.MESSAGE,
      id: message.id,
      occurredAt: createdAtOf(message),
      actorUserId: message.authorUserId || null,
      data: {
        channel: message.channel,
        direction: message.direction,
        authorType: message.authorType,
        status: message.status,
        personId: message.personId,
        body: message.body,
      },
    });
  }

  for (const visit of visits) {
    // Uma visita é posicionada pela data AGENDADA (é a data que o usuário enxerga na
    // negociação), não pelo created_at do registro.
    items.push({
      type: TYPES.VISIT,
      id: visit.id,
      occurredAt: visit.scheduledAt,
      actorUserId: visit.agentUserId || null,
      data: {
        status: visit.status,
        propertyId: visit.propertyId,
        personId: visit.personId,
        scheduledAt: visit.scheduledAt,
        feedback: visit.feedback,
      },
    });
  }

  for (const proposal of proposals) {
    items.push({
      type: TYPES.PROPOSAL,
      id: proposal.id,
      occurredAt: createdAtOf(proposal),
      actorUserId: proposal.createdBy || null,
      data: {
        versionNumber: proposal.versionNumber,
        value: proposal.value,
        currency: proposal.currency,
        status: proposal.status,
        propertyId: proposal.propertyId,
      },
    });
  }

  for (const task of tasks) {
    items.push({
      type: TYPES.TASK,
      id: task.id,
      occurredAt: createdAtOf(task),
      actorUserId: task.createdBy || null,
      data: {
        title: task.title,
        status: task.status,
        priority: task.priority,
        dueAt: task.dueAt,
        assignedToUserId: task.assignedToUserId,
      },
    });
  }

  for (const entry of auditEntries) {
    const type = AUDIT_ACTION_TO_TYPE[entry.action];
    const before = entry.beforeJson || {};
    const after = entry.afterJson || {};
    items.push({
      type,
      id: entry.id,
      occurredAt: entry.occurredAt || createdAtOf(entry),
      actorUserId: entry.userId || null,
      data:
        type === TYPES.STAGE_CHANGE
          ? { fromStage: before.stage || null, toStage: after.stage || null, reason: entry.reason }
          : { stage: after.stage || null, reason: entry.reason },
    });
  }

  if (options.types) {
    const allowed = new Set(options.types.map((t) => String(t).toUpperCase()));
    return sortDesc(items.filter((item) => allowed.has(item.type)));
  }

  return sortDesc(items);
}

/** Mais recente primeiro; empate resolvido pelo tipo + id para a ordem ser determinística. */
function sortDesc(items) {
  return items.sort((a, b) => {
    const diff = toTime(b.occurredAt) - toTime(a.occurredAt);
    if (diff !== 0) return diff;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

module.exports = { TYPES, getOpportunityTimeline };
