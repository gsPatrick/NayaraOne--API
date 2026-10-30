'use strict';

const { Message, Person, Opportunity } = require('../../../../models');

/**
 * Tarefa da mensagem essencial que o WhatsApp não levou dentro do prazo (M9-D227 3.1 item 3): vai para o responsável pelo atendimento (dono da oportunidade da conversa; sem
 * oportunidade, o papel das tarefas manuais da contingência) com o texto objetivo "ligar para o cliente X; mensagem pendente: ...". O nome e o texto ficam só na tarefa
 * interna (o evento do outbox leva apenas ids). Devolve { assignedToUserId, title, description } ou null (vale a tarefa genérica).
 */
async function buildMessageTask(event, transaction) {
  const p = event.payloadJson || {};
  const message = p.dispatchId ? await Message.findOne({ where: { dispatchId: p.dispatchId, companyId: event.companyId }, transaction }) : null;
  if (!message) return null;
  const [pessoa, oportunidade] = await Promise.all([
    message.personId ? Person.findByPk(message.personId, { transaction }) : null,
    message.opportunityId ? Opportunity.findByPk(message.opportunityId, { transaction }) : null,
  ]);
  const nome = pessoa ? (pessoa.preferredName || pessoa.legalName) : 'cliente sem cadastro';
  return {
    assignedToUserId: (oportunidade && oportunidade.ownerUserId) || null,
    title: `Ligar para o cliente ${nome}: mensagem pendente`,
    description: `Ligar para o cliente ${nome}; mensagem pendente: ${String(message.body || '').slice(0, 1500)}`,
  };
}

module.exports = { buildMessageTask };
