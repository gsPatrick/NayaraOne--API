'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, Message, Notification } = require('../../models');
const AppError = require('../../utils/AppError');
const { publishDomainEvent } = require('../../engines/events/outbox');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * Abertura de ocorrência de atendimento pelo livro do Marco 3 (§15 e §17):
 *  - "Interaction pode abrir service_occurrence": `messageId` liga a ocorrência à interação (crm.messages) que a originou.
 *  - evento mínimo `crm.occurrence.opened` (o `crm.feedback_case.created` de sempre continua, para quem já o consome).
 *  - "Reclamação grave escala para gerência": reclamação de severidade HIGH já nasce ESCALATED e avisa a gerência.
 *    O livro não diz quem é a gerência; é quem vê o painel gerencial do CRM (§11 "Gerente visualiza oportunidades sem
 *    atividade"), isto é, os membros ativos da empresa com a permissão `crm:dashboard:read`.
 */

const MANAGER_PERMISSION = 'crm:dashboard:read';

async function resolveOriginInteraction(messageId, personId, transaction) {
  if (!messageId) return null;
  const message = await Message.findByPk(messageId, { transaction });
  if (!message) throw AppError.notFound('Interação não encontrada.', 'MESSAGE_NOT_FOUND');
  if (message.personId && message.personId !== personId) {
    throw AppError.unprocessable('A interação informada é de outra pessoa: a ocorrência precisa ser da mesma pessoa da conversa.', 'FEEDBACK_CASE_INTERACTION_MISMATCH');
  }
  return message;
}

function publishOccurrenceOpened(feedbackCase, transaction) {
  return publishDomainEvent(
    {
      groupId: feedbackCase.groupId,
      companyId: feedbackCase.companyId,
      aggregateType: 'FeedbackCase',
      aggregateId: feedbackCase.id,
      eventType: 'crm.occurrence.opened',
      payload: {
        id: feedbackCase.id,
        type: feedbackCase.type,
        severity: feedbackCase.severity,
        messageId: feedbackCase.messageId || null,
        opportunityId: feedbackCase.opportunityId || null,
        slaDueAt: new Date(feedbackCase.slaDueAt).toISOString(),
      },
      idempotencyKey: `crm.occurrence.opened:${feedbackCase.id}`,
    },
    transaction
  );
}

async function managerUserIds(companyId, transaction) {
  const rows = await sequelize.query(
    `SELECT DISTINCT um.user_id
       FROM core.user_memberships um
       JOIN core.role_permissions rp ON rp.role_id = um.role_id
       JOIN core.permissions p ON p.id = rp.permission_id
      WHERE um.company_id = :companyId AND um.status = 'ACTIVE' AND p.code = :code`,
    { replacements: { companyId, code: MANAGER_PERMISSION }, type: QueryTypes.SELECT, transaction }
  );
  return rows.map((r) => r.user_id);
}

const isGraveComplaint = (feedbackCase) => feedbackCase.type === 'COMPLAINT' && feedbackCase.severity === 'HIGH';

/** Reclamação grave: escalonada na abertura, com aviso a cada gestor (e ao responsável, se houver). */
async function escalateGraveComplaint(feedbackCase, actorUserId, transaction) {
  if (!isGraveComplaint(feedbackCase)) return feedbackCase;
  const beforeJson = feedbackCase.toJSON();
  const escalatedAt = new Date();
  feedbackCase.status = 'ESCALATED';
  feedbackCase.escalatedAt = escalatedAt;
  await feedbackCase.save({ transaction });

  const recipients = new Set(await managerUserIds(feedbackCase.companyId, transaction));
  if (feedbackCase.assignedToUserId) recipients.add(feedbackCase.assignedToUserId);
  for (const userId of recipients) {
    await Notification.create(
      {
        groupId: feedbackCase.groupId,
        companyId: feedbackCase.companyId,
        userId,
        channel: 'IN_APP',
        title: 'Reclamação grave escalonada para a gerência',
        body: `Reclamação de severidade alta aberta: "${String(feedbackCase.description).slice(0, 120)}". Prazo de SLA: ${new Date(feedbackCase.slaDueAt).toLocaleString('pt-BR')}.`,
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
      payload: { id: feedbackCase.id, escalatedAt: escalatedAt.toISOString(), automatic: true, reason: 'GRAVE_COMPLAINT', notifiedUserIds: [...recipients] },
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
      reason: `Reclamação grave (severidade HIGH) escalonada para a gerência na abertura; ${recipients.size} pessoa(s) avisada(s).`,
    },
    transaction
  );
  return feedbackCase;
}

/**
 * Tentativa de apagar uma ocorrência (CRM-TS-015): sempre recusada; a tentativa fica no audit_log, gravado fora da
 * transação da requisição para não ser desfeito junto com a recusa.
 */
async function refuseDeletion(feedbackCase, actorUserId) {
  await registrarAuditoria({
    groupId: feedbackCase.groupId,
    companyId: feedbackCase.companyId,
    actorUserId: actorUserId || null,
    action: 'feedback_case.delete_refused',
    entityType: 'FeedbackCase',
    entityId: feedbackCase.id,
    beforeJson: feedbackCase.toJSON(),
    afterJson: feedbackCase.toJSON(),
    reason: 'Tentativa de apagar ocorrência de atendimento recusada: ocorrência não se apaga para melhorar indicador (livro do Marco 3, §15).',
  });
  throw AppError.conflict('Ocorrência de atendimento não pode ser apagada. Resolva o caso com a conclusão; o histórico fica preservado.', 'FEEDBACK_CASE_DELETE_FORBIDDEN');
}

module.exports = { resolveOriginInteraction, publishOccurrenceOpened, escalateGraveComplaint, refuseDeletion, isGraveComplaint, MANAGER_PERMISSION };
