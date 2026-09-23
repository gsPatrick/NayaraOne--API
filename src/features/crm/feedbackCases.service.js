'use strict';

const { Op } = require('sequelize');
const { FeedbackCase, Person, Opportunity, Notification } = require('../../models');
const AppError = require('../../utils/AppError');
const { publishDomainEvent } = require('../../engines/events/outbox');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * M3-20 — Reclamações, elogios e conflitos com SLA e escalonamento.
 *
 * DECISÃO DE ENGENHARIA (os prazos NÃO estavam explicitados no Caderno CURRENT — Marco 3):
 *   HIGH   = 24 horas
 *   MEDIUM = 72 horas
 *   LOW    = 7 dias
 * O `slaDueAt` é CALCULADO NA CRIAÇÃO e PERSISTIDO — não recalculado na leitura — porque o
 * prazo prometido ao cliente não pode mudar retroativamente se a política de SLA for alterada
 * depois. Mudar a `severity` de um caso já aberto, por isso mesmo, NÃO reescreve o SLA
 * original (ver `resolveFeedbackCase`/`escalateFeedbackCase`: nenhum deles toca em slaDueAt).
 *
 * Elogio (COMPLIMENT) também recebe SLA: o prazo vale como "responder/agradecer", o que
 * mantém uma única máquina de estados para os três tipos em vez de um caso especial.
 *
 * Escalonamento: manual (`escalateFeedbackCase`) ou automático quando o SLA vence, pelo job
 * src/engines/jobs/feedbackCaseAlertJob.js. Os dois caminhos passam pela MESMA função, então
 * não existe divergência de comportamento entre escalonar na mão e escalonar pelo job.
 */

const TYPES = ['COMPLAINT', 'COMPLIMENT', 'CONFLICT'];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'];
const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'ESCALATED'];

/** Janela de SLA por severidade, em horas. */
const SLA_HOURS_BY_SEVERITY = {
  HIGH: 24,
  MEDIUM: 72,
  LOW: 24 * 7,
};

/** Status que ainda estão "em aberto" e portanto sujeitos a escalonamento por SLA vencido. */
const ESCALATABLE_STATUSES = ['OPEN', 'IN_PROGRESS'];

function computeSlaDueAt(severity, from = new Date()) {
  const hours = SLA_HOURS_BY_SEVERITY[String(severity || '').toUpperCase()];
  if (!hours) {
    throw AppError.badRequest(`O campo "severity" deve ser um de: ${SEVERITIES.join(', ')}.`, 'FEEDBACK_CASE_VALIDATION');
  }
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

async function createFeedbackCase(payload, actorUserId, transaction) {
  const { groupId, companyId, personId, opportunityId, type, description, severity, assignedToUserId } = payload;

  if (!groupId || !companyId || !personId || !type || !description) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "personId", "type" e "description" são obrigatórios.',
      'FEEDBACK_CASE_VALIDATION'
    );
  }

  const normalizedType = String(type).toUpperCase();
  if (!TYPES.includes(normalizedType)) {
    throw AppError.badRequest(`O campo "type" deve ser um de: ${TYPES.join(', ')}.`, 'FEEDBACK_CASE_VALIDATION');
  }

  const normalizedSeverity = severity ? String(severity).toUpperCase() : 'MEDIUM';
  if (!SEVERITIES.includes(normalizedSeverity)) {
    throw AppError.badRequest(`O campo "severity" deve ser um de: ${SEVERITIES.join(', ')}.`, 'FEEDBACK_CASE_VALIDATION');
  }

  const person = await Person.findByPk(personId, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');

  if (opportunityId) {
    const opportunity = await Opportunity.findByPk(opportunityId, { transaction });
    if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
  }

  const slaDueAt = computeSlaDueAt(normalizedSeverity);

  const feedbackCase = await FeedbackCase.create(
    {
      groupId,
      companyId,
      personId,
      opportunityId: opportunityId || null,
      type: normalizedType,
      description,
      severity: normalizedSeverity,
      status: 'OPEN',
      assignedToUserId: assignedToUserId || null,
      slaDueAt,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishDomainEvent(
    {
      groupId,
      companyId,
      aggregateType: 'FeedbackCase',
      aggregateId: feedbackCase.id,
      eventType: 'crm.feedback_case.created',
      payload: {
        id: feedbackCase.id,
        type: normalizedType,
        severity: normalizedSeverity,
        slaDueAt: slaDueAt.toISOString(),
      },
      idempotencyKey: `crm.feedback_case.created:${feedbackCase.id}`,
    },
    transaction
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'feedback_case.create',
      entityType: 'FeedbackCase',
      entityId: feedbackCase.id,
      afterJson: feedbackCase.toJSON(),
      reason: `Caso de ${normalizedType} (severidade ${normalizedSeverity}) aberto para "${person.legalName || personId}" com SLA até ${slaDueAt.toISOString()}.`,
    },
    transaction
  );

  return feedbackCase;
}

async function listFeedbackCases(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.type) where.type = String(filters.type).toUpperCase();
  if (filters.severity) where.severity = String(filters.severity).toUpperCase();
  if (filters.personId) where.personId = filters.personId;
  if (filters.assignedToUserId) where.assignedToUserId = filters.assignedToUserId;
  if (filters.overdue) {
    where.status = { [Op.in]: ESCALATABLE_STATUSES };
    where.slaDueAt = { [Op.lt]: new Date() };
  }
  return FeedbackCase.findAll({ where, order: [['sla_due_at', 'ASC']], transaction });
}

async function getFeedbackCase(id, transaction, { lock = false } = {}) {
  // FIX (homologação 23/09/2026 — auditoria adversarial de corrida): resolveFeedbackCase e
  // escalateFeedbackCase liam o caso sem lock pessimista e decidiam a transição de status com
  // base nessa leitura. Dois agentes agindo sobre o mesmo caso ao mesmo tempo (um resolve, outro
  // escalona) podiam ambos passar da guarda de status e gravar, perdendo silenciosamente uma das
  // duas decisões e deixando a trilha de auditoria/eventos de domínio contraditória. Quem chama
  // dentro de um fluxo de escrita passa `{ lock: true }` para travar a linha (SELECT ... FOR
  // UPDATE) e serializar concorrentes.
  const feedbackCase = await FeedbackCase.findByPk(id, {
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!feedbackCase) throw AppError.notFound('Caso de feedback não encontrado.', 'FEEDBACK_CASE_NOT_FOUND');
  return feedbackCase;
}

async function resolveFeedbackCase(id, payload, actorUserId, transaction) {
  const feedbackCase = await getFeedbackCase(id, transaction, { lock: true });
  const beforeJson = feedbackCase.toJSON();

  if (feedbackCase.status === 'RESOLVED') {
    throw AppError.unprocessable('Este caso já está resolvido.', 'FEEDBACK_CASE_ALREADY_RESOLVED', { id });
  }

  const resolvedAt = new Date();
  feedbackCase.status = 'RESOLVED';
  feedbackCase.resolvedAt = resolvedAt;
  feedbackCase.resolutionNotes = (payload && payload.resolutionNotes) || null;
  feedbackCase.updatedBy = actorUserId || null;
  await feedbackCase.save({ transaction });

  await publishDomainEvent(
    {
      groupId: feedbackCase.groupId,
      companyId: feedbackCase.companyId,
      aggregateType: 'FeedbackCase',
      aggregateId: feedbackCase.id,
      eventType: 'crm.feedback_case.resolved',
      payload: {
        id: feedbackCase.id,
        resolvedAt: resolvedAt.toISOString(),
        withinSla: resolvedAt <= new Date(feedbackCase.slaDueAt),
      },
      idempotencyKey: `crm.feedback_case.resolved:${feedbackCase.id}`,
    },
    transaction
  );

  await registrarAuditoria(
    {
      groupId: feedbackCase.groupId,
      companyId: feedbackCase.companyId,
      actorUserId,
      action: 'feedback_case.resolve',
      entityType: 'FeedbackCase',
      entityId: feedbackCase.id,
      beforeJson,
      afterJson: feedbackCase.toJSON(),
      reason: `Caso de ${feedbackCase.type} resolvido${resolvedAt <= new Date(feedbackCase.slaDueAt) ? ' dentro do SLA' : ' FORA do SLA'}.`,
    },
    transaction
  );

  return feedbackCase;
}

/**
 * escalateFeedbackCase — marca `escalatedAt`, muda o status para ESCALATED e notifica o
 * responsável (Notification IN_APP, mesmo padrão de legalDeadlineAlertJob.js).
 *
 * `actorUserId` é null quando quem escalona é o job automático (SLA vencido); `reason` conta
 * na auditoria qual dos dois caminhos aconteceu.
 */
async function escalateFeedbackCase(id, payload, actorUserId, transaction) {
  const feedbackCase = await getFeedbackCase(id, transaction, { lock: true });
  const beforeJson = feedbackCase.toJSON();

  if (feedbackCase.status === 'RESOLVED') {
    throw AppError.unprocessable(
      'Um caso já resolvido não pode ser escalonado.',
      'FEEDBACK_CASE_ALREADY_RESOLVED',
      { id }
    );
  }
  if (feedbackCase.status === 'ESCALATED') {
    throw AppError.unprocessable('Este caso já está escalonado.', 'FEEDBACK_CASE_ALREADY_ESCALATED', { id });
  }

  const automatic = Boolean(payload && payload.automatic);
  const escalatedAt = new Date();
  feedbackCase.status = 'ESCALATED';
  feedbackCase.escalatedAt = escalatedAt;
  feedbackCase.updatedBy = actorUserId || null;
  await feedbackCase.save({ transaction });

  if (feedbackCase.assignedToUserId) {
    await Notification.create(
      {
        groupId: feedbackCase.groupId,
        companyId: feedbackCase.companyId,
        userId: feedbackCase.assignedToUserId,
        channel: 'IN_APP',
        title: `Caso de ${feedbackCase.type} ESCALONADO (severidade ${feedbackCase.severity})`,
        body:
          `O caso "${String(feedbackCase.description).slice(0, 120)}" foi escalonado` +
          `${automatic ? ' automaticamente por SLA vencido' : ''}. ` +
          `Prazo de SLA: ${new Date(feedbackCase.slaDueAt).toLocaleString('pt-BR')}.`,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }

  await publishDomainEvent(
    {
      groupId: feedbackCase.groupId,
      companyId: feedbackCase.companyId,
      aggregateType: 'FeedbackCase',
      aggregateId: feedbackCase.id,
      eventType: 'crm.feedback_case.escalated',
      payload: {
        id: feedbackCase.id,
        escalatedAt: escalatedAt.toISOString(),
        automatic,
        slaDueAt: new Date(feedbackCase.slaDueAt).toISOString(),
      },
      idempotencyKey: `crm.feedback_case.escalated:${feedbackCase.id}`,
    },
    transaction
  );

  await registrarAuditoria(
    {
      groupId: feedbackCase.groupId,
      companyId: feedbackCase.companyId,
      actorUserId,
      action: 'feedback_case.escalate',
      entityType: 'FeedbackCase',
      entityId: feedbackCase.id,
      beforeJson,
      afterJson: feedbackCase.toJSON(),
      reason: automatic
        ? `Caso de ${feedbackCase.type} escalonado AUTOMATICAMENTE — SLA venceu em ${new Date(feedbackCase.slaDueAt).toISOString()}.`
        : `Caso de ${feedbackCase.type} escalonado manualmente.`,
    },
    transaction
  );

  return feedbackCase;
}

module.exports = {
  TYPES,
  SEVERITIES,
  STATUSES,
  SLA_HOURS_BY_SEVERITY,
  ESCALATABLE_STATUSES,
  computeSlaDueAt,
  createFeedbackCase,
  listFeedbackCases,
  getFeedbackCase,
  resolveFeedbackCase,
  escalateFeedbackCase,
};
