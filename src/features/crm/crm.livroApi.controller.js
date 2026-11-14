'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const AppError = require('../../utils/AppError');
const opportunitiesService = require('./opportunity.service');
const visitsService = require('./visits.service');
const messagesService = require('./messages.service');
const feedbackCasesService = require('./feedbackCases.service');
const { refuseDeletion } = require('./feedbackCaseOpening');
const { bulkReassign } = require('./opportunityReassign.service');
const { readOutcomeReasonCatalog } = require('./crm.params');
const { assertRecordBodyLimit } = require('./messaging/messaging.textLimits');

/**
 * Endpoints com o caminho do Guia do Marcelo §13 ("APIs mínimas") que o sistema atendia por outro caminho
 * (/opportunities, /messages, /visits, PATCH de estágio, /radar, /crm/feedback-cases). Cada um delega ao MESMO service do
 * caminho original: mesmas regras, permissões, auditoria e eventos; só o formato do pedido segue o livro.
 */

const DIRECTION = { IN: 'INBOUND', OUT: 'OUTBOUND', INBOUND: 'INBOUND', OUTBOUND: 'OUTBOUND' };

/** POST /crm/opportunities/:id/interactions — Guia §10: { channel, direction IN|OUT, occurredAt, summary, externalMessageId? }. */
const recordInteraction = catchAsync(async (req, res) => {
  const body = req.body || {};
  const direction = DIRECTION[String(body.direction || '').toUpperCase()];
  if (!direction) throw AppError.badRequest('O campo "direction" deve ser IN ou OUT.', 'MESSAGE_VALIDATION');
  if (!body.summary || !String(body.summary).trim()) throw AppError.badRequest('O campo "summary" (resumo do contato) é obrigatório.', 'MESSAGE_VALIDATION');
  const message = await req.withTenantTransaction(async (transaction) => {
    const opportunity = await opportunitiesService.getOpportunity(req.params.id, transaction);
    // O mesmo limite do registro de POST /messages (DI-M9R-16, integration.messaging.record_body_max_chars).
    await assertRecordBodyLimit(req.auth, String(body.summary).trim(), transaction);
    return messagesService.createMessage(
      {
        groupId: req.auth.groupId,
        companyId: req.auth.companyId,
        personId: opportunity.personId,
        opportunityId: opportunity.id,
        channel: body.channel,
        direction,
        authorType: direction === 'OUTBOUND' ? 'EMPLOYEE' : 'CLIENT',
        authorUserId: direction === 'OUTBOUND' ? req.auth.userId : null,
        body: String(body.summary).trim(),
        occurredAt: body.occurredAt,
        externalMessageId: body.externalMessageId,
        purpose: body.purpose,
      },
      req.auth.userId,
      transaction
    );
  });
  return success(res, { statusCode: 201, data: message });
});

/** POST /crm/opportunities/:id/visits — agenda a visita da oportunidade. */
const scheduleVisit = catchAsync(async (req, res) => {
  const visit = await req.withTenantTransaction(async (transaction) => {
    const opportunity = await opportunitiesService.getOpportunity(req.params.id, transaction);
    return visitsService.createVisit(
      { ...req.body, opportunityId: opportunity.id, personId: (req.body && req.body.personId) || opportunity.personId, groupId: req.auth.groupId, companyId: req.auth.companyId },
      req.auth.userId,
      transaction
    );
  });
  return success(res, { statusCode: 201, data: visit });
});

/** POST /crm/opportunities/:id/lost — Guia §8 markLost(opportunityId, reasonCode): sem motivo, não fecha. */
const markLost = catchAsync(async (req, res) => {
  const body = req.body || {};
  const opportunity = await req.withTenantTransaction((transaction) =>
    opportunitiesService.updateOpportunity(req.params.id, { stage: 'LOST', lostReason: body.reasonCode !== undefined ? body.reasonCode : body.lostReason }, req.auth.userId, transaction)
  );
  return success(res, { data: opportunity });
});

/** DELETE /crm/feedback-cases/:id e /crm/occurrences/:id — CRM-TS-015: sempre recusado e auditado. */
const refuseOccurrenceDeletion = catchAsync(async (req) => {
  const feedbackCase = await req.withTenantTransaction((transaction) => feedbackCasesService.getFeedbackCase(req.params.id, transaction));
  await refuseDeletion(feedbackCase, req.auth.userId);
});

/** POST /crm/opportunities/reassign — §18 troca de responsável em massa (permissão dedicada na rota). */
const reassignOwners = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    bulkReassign(req.body, { userId: req.auth.userId, companyId: req.auth.companyId }, transaction)
  );
  return success(res, { data: result });
});

/** GET /crm/outcome-reasons — motivos de ganho, perda e desistência configurados pela empresa (§3 crm.loss_reasons; DI-M3CA-2). */
const listOutcomeReasons = catchAsync(async (req, res) => {
  const catalog = await req.withTenantTransaction((transaction) =>
    readOutcomeReasonCatalog({ groupId: req.auth.groupId, companyId: req.auth.companyId }, transaction)
  );
  return success(res, { data: catalog });
});

module.exports = { recordInteraction, scheduleVisit, markLost, refuseOccurrenceDeletion, reassignOwners, listOutcomeReasons };
