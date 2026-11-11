'use strict';

const { Op } = require('sequelize');
const { FeedbackCase, Person, Opportunity, Notification } = require('../../models');
const AppError = require('../../utils/AppError');
const { publishDomainEvent } = require('../../engines/events/outbox');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const opening = require('./feedbackCaseOpening');
const { readSlaHoursBySeverity } = require('./crm.params');
const { isActiveMember, managerUserIds, resolveOwnerUserId } = require('./crmUsers');

/**
 * M3-20 — Reclamações, elogios e conflitos com SLA e escalonamento.
 *
 * SLA por severidade = parâmetros da empresa (livro §15 "Ocorrência possui responsável, SLA, severidade e conclusão"; o livro
 * não fixa os prazos — DI-M3CA-6): crm.ocorrencia.sla_horas.alta / .media / .baixa (padrões 24, 72 e 168 horas).
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
 * não existe divergência de comportamento entre escalonar na mão e escalonar pelo job. O aviso vai ao responsável E à
 * gerência (membros com a permissão de `crm.gerencia.permissao`), como o livro §15 manda para a reclamação grave.
 *
 * Responsável obrigatório (§15): o informado (usuário ativo da empresa) ou, na falta, o responsável da oportunidade, quem abre
 * ou o responsável padrão do lead automático / gestor mais antigo (crmUsers.resolveOwnerUserId). Nunca nulo.
 */

// Livro do Marco 3 §15: reclamação, elogio, conflito, atendimento inadequado (POOR_SERVICE) e retorno pendente (PENDING_RETURN).
const TYPES = ['COMPLAINT', 'COMPLIMENT', 'CONFLICT', 'POOR_SERVICE', 'PENDING_RETURN'];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'];
const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'ESCALATED'];


/** Status que ainda estão "em aberto" e portanto sujeitos a escalonamento por SLA vencido. */
const ESCALATABLE_STATUSES = ['OPEN', 'IN_PROGRESS'];

async function computeSlaDueAt(severity, tenant, transaction, from = new Date()) {
  const hours = (await readSlaHoursBySeverity(tenant, transaction))[String(severity || '').toUpperCase()];
  if (!hours) {
    throw AppError.badRequest(`O campo "severity" deve ser um de: ${SEVERITIES.join(', ')}.`, 'FEEDBACK_CASE_VALIDATION');
  }
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

async function createFeedbackCase(payload, actorUserId, transaction) {
  const { groupId, companyId, personId, opportunityId, messageId, type, description, severity, assignedToUserId } = payload;

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

  const tenant = { groupId, companyId };
  const originMessage = await opening.resolveOriginInteraction(messageId, personId, transaction);
  const linkedOpportunityId = opportunityId || (originMessage && originMessage.opportunityId) || null;
  let opportunity = null;
  if (linkedOpportunityId) {
    opportunity = await Opportunity.findByPk(linkedOpportunityId, { transaction });
    if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
  }
  if (assignedToUserId && !(await isActiveMember(assignedToUserId, companyId, transaction))) {
    throw AppError.unprocessable('O responsável da ocorrência precisa ser um usuário ativo desta empresa.', 'FEEDBACK_CASE_ASSIGNEE_INVALID', { assignedToUserId });
  }
  const responsibleUserId = await resolveOwnerUserId(
    { ownerUserId: assignedToUserId || (opportunity && opportunity.ownerUserId) || null, actorUserId },
    tenant,
    transaction
  );
  const slaDueAt = await computeSlaDueAt(normalizedSeverity, tenant, transaction);

  const feedbackCase = await FeedbackCase.create(
    {
      groupId,
      companyId,
      personId,
      opportunityId: linkedOpportunityId,
      messageId: originMessage ? originMessage.id : null,
      type: normalizedType,
      description,
      severity: normalizedSeverity,
      status: 'OPEN',
      assignedToUserId: responsibleUserId,
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

  await opening.publishOccurrenceOpened(feedbackCase, transaction);
  await opening.escalateGraveComplaint(feedbackCase, actorUserId, transaction);

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

  // BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07): o contrato (seção "Reclamações,
  // elogios e conflitos") exige que toda ocorrência tenha "responsável, SLA, severidade e
  // conclusão" — SLA e severidade já eram obrigatórios na criação, mas nada aqui impedia
  // resolver um caso sem responsável atribuído nem sem texto de conclusão. Fail closed: exige
  // os dois antes de permitir a transição para RESOLVED.
  const resolutionNotes = payload && typeof payload.resolutionNotes === 'string' ? payload.resolutionNotes.trim() : '';
  if (!resolutionNotes) {
    throw AppError.badRequest(
      'O campo "resolutionNotes" (conclusão) é obrigatório para resolver um caso de feedback.',
      'FEEDBACK_CASE_RESOLUTION_REQUIRED'
    );
  }
  const assignedToUserId = (payload && payload.assignedToUserId) || feedbackCase.assignedToUserId;
  if (!assignedToUserId) {
    throw AppError.badRequest(
      'Este caso não tem responsável atribuído. Informe "assignedToUserId" antes de resolver.',
      'FEEDBACK_CASE_ASSIGNEE_REQUIRED'
    );
  }

  const resolvedAt = new Date();
  feedbackCase.status = 'RESOLVED';
  feedbackCase.resolvedAt = resolvedAt;
  feedbackCase.resolutionNotes = resolutionNotes;
  feedbackCase.assignedToUserId = assignedToUserId;
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

  // Livro §15: o escalonamento chega à gerência (e ao responsável).
  const recipients = new Set(await managerUserIds({ groupId: feedbackCase.groupId, companyId: feedbackCase.companyId }, transaction));
  if (feedbackCase.assignedToUserId) recipients.add(feedbackCase.assignedToUserId);
  for (const userId of recipients) {
    await Notification.create(
      {
        groupId: feedbackCase.groupId,
        companyId: feedbackCase.companyId,
        userId,
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
        notifiedUserIds: [...recipients],
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
      reason: `${automatic
        ? `Caso de ${feedbackCase.type} escalonado AUTOMATICAMENTE — SLA venceu em ${new Date(feedbackCase.slaDueAt).toISOString()}.`
        : `Caso de ${feedbackCase.type} escalonado manualmente.`} ${recipients.size} pessoa(s) avisada(s), gerência incluída.`,
    },
    transaction
  );

  return feedbackCase;
}

module.exports = {
  TYPES,
  SEVERITIES,
  STATUSES,
  ESCALATABLE_STATUSES,
  computeSlaDueAt,
  createFeedbackCase,
  listFeedbackCases,
  getFeedbackCase,
  resolveFeedbackCase,
  escalateFeedbackCase,
};
