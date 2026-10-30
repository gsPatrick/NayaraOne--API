'use strict';

const { createFeedbackCase } = require('../../../crm/feedbackCases.service');
const repo = require('./review.repository');
const { auditReview } = require('./review.audit');

const LOWEST_SCORE = 1;

/**
 * Nota negativa: abre a ocorrência no CRM (serviço de ocorrências, com SLA e responsável) e registra o pedido como BLOCKED_NEGATIVE com o feedback_case_id. NENHUMA
 * solicitação sai. Não existe liberação manual: um novo pedido só nasce de uma nova nota positiva, depois que a ocorrência estiver resolvida.
 */
async function negative({ input, facts, channel }) {
  const { tenant, transaction, personId } = input;
  const actor = input.ownerUserId || null;
  const kase = await createFeedbackCase({
    groupId: tenant.groupId, companyId: tenant.companyId, personId, type: 'COMPLAINT', severity: facts.score <= LOWEST_SCORE ? 'HIGH' : 'MEDIUM', assignedToUserId: actor,
    description: `Pesquisa de satisfação com nota ${facts.score} de 5. Trate a ocorrência antes de qualquer pedido de avaliação.`,
  }, actor, transaction);
  const row = await repo.insert(tenant, actor, { personId, sourceType: facts.sourceType, sourceId: facts.sourceId, score: facts.score, status: 'BLOCKED_NEGATIVE', feedbackCaseId: kase.id, channel, key: input.idempotencyKey }, transaction);
  if (!row) return { reviewRequestId: null, blocked: 'MKT_REVIEW_ALREADY_REGISTERED' };
  await auditReview(tenant, actor, 'marketing.review_request.blocked_negative', null, row, `Nota ${facts.score} de satisfação: ocorrência aberta antes de qualquer pedido de avaliação.`, transaction);
  return { reviewRequestId: row.id, status: 'BLOCKED_NEGATIVE', feedbackCaseId: kase.id };
}

module.exports = { negative };
