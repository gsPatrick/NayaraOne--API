'use strict';

const { sequelize, EmailMessage, EmailMessageEvent } = require('../../../models');

const DEFINITIVE = ['FAILED', 'DEAD_LETTER', 'CANCELLED'];

/**
 * Mensagem cujo envio ao provedor terminou sem sucesso (falha definitiva, fila morta ou cancelado) e que nunca recebeu identificador: vira FAILED, com o código do erro do
 * envio e um evento no histórico (M9-D234 3.2 item 2: falha registrada como veio). Idempotente: só toca mensagem ainda QUEUED. Devolve quantas mensagens mudaram.
 */
async function syncFailedMessages(ctx, transaction) {
  const [linhas] = await sequelize.query(
    `SELECT m.id, d.last_error_code AS code FROM integration.email_messages m JOIN integration.dispatches d ON d.id = m.dispatch_id
      WHERE m.company_id = :c AND m.status = 'QUEUED' AND d.status IN (:definitivos) LIMIT 200`,
    { replacements: { c: ctx.companyId, definitivos: DEFINITIVE }, transaction },
  );
  for (const linha of linhas) {
    const motivo = `O provedor não aceitou o envio${linha.code ? ` (${String(linha.code).slice(0, 64)})` : ''}.`;
    await EmailMessage.update({ status: 'FAILED', failureReason: motivo, lastEventAt: new Date() }, { where: { id: linha.id, companyId: ctx.companyId, status: 'QUEUED' }, transaction });  
    const message = await EmailMessage.findByPk(linha.id, { transaction });  
    await EmailMessageEvent.create({ groupId: message.groupId, companyId: message.companyId, messageId: message.id, kind: 'FAILED', previousStatus: 'QUEUED', detail: motivo, occurredAt: new Date() }, { transaction });  
  }
  return linhas.length;
}

module.exports = { syncFailedMessages };
