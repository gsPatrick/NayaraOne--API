'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, FinancingCase, ProviderSubmission } = require('../../../models');
const logger = require('../../../utils/logger');
const contingency = require('../../integrations/contingency/contingency.domainHooks');
const { transitionDispatch } = require('../../integrations/dispatch/dispatch.transition');
const { REASONS, recordProviderSwitch } = require('./providerSwitch');

const MANUAL = 'manual';
const MOTIVO = 'A promotora ficou fora além do prazo da fila: o caso segue pelo fluxo manual assistido (a promotora é contatada por canal humano e o analista registra o status com evidência).';

/**
 * Promotora fora, depois do prazo da fila (`queue_max_age_h` do modo QUEUE_QUERY_OR_ALTERNATE_PROVIDER, 24 h, M9-D228 3.3): sem alternativo elegível, a submissão que continua na fila
 * passa para o FLUXO MANUAL (`ManualWorkflowFinancingProviderAdapter`): o envio da fila do provider que caiu é cancelado, o caso passa a ter o provider manual (o original fica no histórico)
 * e a submissão PENDING segue para o worker, que a entrega ao fluxo manual. A exclusividade contratual não impede o manual: é a mesma promotora, contatada por pessoas.
 */
async function moveSubmissionToManual(ctx, { submissionId, dispatchId }, transaction) {
  const submission = await ProviderSubmission.findOne({ where: { id: submissionId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!submission || submission.status !== 'PENDING') return false;
  const financingCase = await FinancingCase.findOne({ where: { id: submission.financingCaseId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!financingCase || financingCase.providerCode === MANUAL || ['CANCELED', 'REJECTED', 'COMPLETED'].includes(financingCase.status)) return false;
  await transitionDispatch(ctx, dispatchId, 'CANCELLED', {}, { motivo: MOTIVO }, transaction);
  return recordProviderSwitch(financingCase, submission, { toCode: MANUAL, reason: REASONS.MANUAL, dispatchId }, transaction);
}

async function financingStep(ctx, { connection, policy, now }, transaction) {
  if (policy.queueMaxAgeH === null || policy.queueMaxAgeH === undefined) return null;
  const corte = new Date(now.getTime() - policy.queueMaxAgeH * 3600000);
  const itens = await sequelize.query(
    `SELECT s.id AS "submissionId", d.id AS "dispatchId"
       FROM "correspondent"."provider_submissions" s
       JOIN "integration"."dispatches" d ON d.company_id = s.company_id AND d.aggregate_type = 'ProviderSubmission' AND d.aggregate_id = s.id AND d.operation = 'submitCase'
      WHERE s.company_id = :companyId AND s.status = 'PENDING' AND d.connection_id = :connectionId AND d.status IN ('PENDING', 'RETRY_WAIT') AND d.created_at <= :corte
        AND NOT EXISTS (SELECT 1 FROM "integration"."connections" m WHERE m.id = d.connection_id AND m.provider_code = :manualProvider)
      ORDER BY d.created_at ASC, d.id ASC LIMIT 100`,
    { replacements: { companyId: ctx.companyId, connectionId: connection.id, corte, manualProvider: 'financing-manual' }, type: QueryTypes.SELECT, transaction },
  );
  let moved = 0;
  for (const item of itens) {
    try {
      if (await sequelize.transaction({ transaction }, (sp) => moveSubmissionToManual(ctx, item, sp))) moved += 1;
    } catch (err) {
      logger.warn({ submissionId: item.submissionId, err: err.message, code: err.code }, 'Contingência do financiamento: o caso não pôde seguir pelo fluxo manual; ele segue na fila.');
    }
  }
  return { switched: moved, manual: moved };
}

let installed = false;
function installFinancingContingency() {
  if (installed) return;
  installed = true;
  contingency.registerContingencyStep('FINANCING', financingStep);
}

module.exports = { installFinancingContingency, moveSubmissionToManual, financingStep };
