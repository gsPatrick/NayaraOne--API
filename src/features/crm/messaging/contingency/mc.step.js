'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, IntegrationConnection, IntegrationProvider } = require('../../../../models');
const logger = require('../../../../utils/logger');
const { QUEUED_STATUSES } = require('../../../integrations/contingency/contingency.constants');
const { sendViaAlternateChannel } = require('./mc.email');
const { NOT_MARKETING_SQL } = require('./mc.essential');

const RECUSAS_ESPERADAS = ['MESSAGE_NOT_FOUND', 'INTEGRATION_MESSAGING_NO_CONSENT_ALTERNATE', 'INTEGRATION_MESSAGING_NO_ALTERNATE_ADDRESS', 'INTEGRATION_ALTERNATE_NOT_ELIGIBLE', 'INTEGRATION_MESSAGING_ALTERNATE_NOT_APPLICABLE'];

/** O alternativo da política é uma connection de e-mail (outra família: o canal alternativo do contato)? Alternativo da mesma família é a troca do framework (M9-D226). */
async function emailAlternate(ctx, policy, transaction) {
  if (!policy.alternateConnectionId) return null;
  const alt = await IntegrationConnection.findOne({ where: { id: policy.alternateConnectionId, companyId: ctx.companyId }, transaction });
  const provider = alt ? await IntegrationProvider.findByPk(alt.providerCode, { attributes: ['code', 'domain'], transaction }) : null;
  return provider && provider.domain === 'EMAIL' ? alt : null;
}

/**
 * Passo da contingência do WhatsApp por connection (M9-D227 3.1 item 2): com o alternativo de e-mail na política, cada mensagem essencial de texto da fila segue por e-mail se o contato
 * autorizou o canal. Sem consentimento, sem endereço ou com o alternativo inelegível, a mensagem NÃO muda: segue na fila e, passado o prazo, vira a tarefa do responsável. Cada mensagem num savepoint.
 */
async function messagingStep(ctx, { connection, policy, params, now }, transaction) {
  if (!(await emailAlternate(ctx, policy, transaction))) return null;
  const itens = await sequelize.query(
    `SELECT m.id FROM "integration"."dispatches" d JOIN "crm"."messages" m ON m.dispatch_id = d.id AND m.company_id = d.company_id
      WHERE d.company_id = :companyId AND d.connection_id = :connectionId AND d.status IN (:statuses) AND d.operation = 'sendText' AND m.delivery_status = 'QUEUED' ${NOT_MARKETING_SQL}
      ORDER BY d.created_at ASC, d.id ASC LIMIT :limit`,
    { replacements: { companyId: ctx.companyId, connectionId: connection.id, statuses: QUEUED_STATUSES, limit: params.drainBatchSize }, type: QueryTypes.SELECT, transaction },
  );
  let switched = 0;
  for (const { id } of itens) {
    try {
      await sequelize.transaction({ transaction }, (sp) => sendViaAlternateChannel(ctx, id, { now }, sp));
      switched += 1;
    } catch (err) {
      if (!RECUSAS_ESPERADAS.includes(err.code)) logger.warn({ messageId: id, err: err.message, code: err.code }, 'Contingência do WhatsApp: a mensagem não pôde seguir por e-mail; ela segue na fila.');
    }
  }
  return { switched };
}

module.exports = { messagingStep, emailAlternate };
