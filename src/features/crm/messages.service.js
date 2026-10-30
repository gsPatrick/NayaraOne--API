'use strict';

const { Message, Person, Opportunity } = require('../../models');
const AppError = require('../../utils/AppError');
const { canContact } = require('../people/personConsents.service');
const { publishDomainEvent } = require('../../engines/events/outbox');
const { createOnceByActionKey } = require('../../utils/createOnceByActionKey');
const { businessDateKey } = require('../../utils/businessDate');

const DIRECTIONS = ['INBOUND', 'OUTBOUND'];
const AUTHOR_TYPES = ['CLIENT', 'NAY', 'EMPLOYEE'];
/**
 * M3-24 (correção): `channel` era gravado sem NENHUMA validação (a coluna é só um
 * VARCHAR(32) sem CHECK), então um typo — "whatsap", "zap", "" — entrava no histórico e
 * quebrava silenciosamente qualquer filtro/relatório por canal. Enum fechado, mesmo padrão de
 * `direction`/`authorType`.
 */
const CHANNELS = ['WHATSAPP', 'EMAIL', 'SMS', 'PHONE', 'IN_PERSON', 'PORTAL', 'INSTAGRAM', 'OTHER'];

/**
 * "crm"."messages" não tem `deleted_at`/paranoid no model (ver src/models/Message.js) — é
 * append-only por design (histórico de atendimento nunca é apagado). Este service expõe
 * apenas create/list/get e uma atualização restrita de `status` (ex.: RECEIVED -> READ),
 * nunca delete nem edição de `body`.
 */
async function createMessage(payload, actorUserId, transaction) {
  const { groupId, companyId, personId, opportunityId, channel, direction, authorType, authorUserId, body, externalMessageId, purpose, actionKey, connectionId, dispatchId, deliveryStatus } = payload;

  if (!groupId || !companyId || !direction || !authorType) {
    throw AppError.badRequest('Os campos "groupId", "companyId", "direction" e "authorType" são obrigatórios.', 'MESSAGE_VALIDATION');
  }

  const normalizedDirection = String(direction).toUpperCase();
  if (!DIRECTIONS.includes(normalizedDirection)) {
    throw AppError.badRequest(`O campo "direction" deve ser um de: ${DIRECTIONS.join(', ')}.`, 'MESSAGE_VALIDATION');
  }
  const normalizedAuthorType = String(authorType).toUpperCase();
  if (!AUTHOR_TYPES.includes(normalizedAuthorType)) {
    throw AppError.badRequest(`O campo "authorType" deve ser um de: ${AUTHOR_TYPES.join(', ')}.`, 'MESSAGE_VALIDATION');
  }

  const normalizedChannel = channel ? String(channel).toUpperCase() : 'WHATSAPP';
  if (!CHANNELS.includes(normalizedChannel)) {
    throw AppError.badRequest(`O campo "channel" deve ser um de: ${CHANNELS.join(', ')}.`, 'MESSAGE_VALIDATION');
  }

  let person = null;
  if (personId) {
    person = await Person.findByPk(personId, { transaction });
    if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  }

  // Bloqueio ATIVO de opt-out (Guia do Marcelo §11/§18 "Não ignorar opt-out.";
  // CRM-TS-009 "Opt-out — Cadência tenta enviar — Bloqueado."). Só se aplica a envio SAÍDO
  // (OUTBOUND) para uma pessoa identificada — mensagem recebida do cliente (INBOUND) nunca é
  // bloqueada por consentimento (o cliente está livre pra falar com a empresa mesmo tendo
  // pedido pra não ser contatado).
  if (person && normalizedDirection === 'OUTBOUND') {
    const allowed = await canContact(person, normalizedChannel, purpose || 'TRANSACTIONAL', transaction);
    if (!allowed) {
      throw AppError.unprocessable(
        'Envio bloqueado: a pessoa optou por não receber contato (opt-out) neste canal/finalidade, ou a finalidade exige opt-in explícito ausente.',
        'MESSAGE_BLOCKED_BY_CONSENT',
        { personId, channel: normalizedChannel, purpose: purpose || 'TRANSACTIONAL' }
      );
    }
  }

  if (opportunityId) {
    const opportunity = await Opportunity.findByPk(opportunityId, { transaction });
    if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
  }

  if (externalMessageId) {
    const existing = await Message.findOne({ where: { externalMessageId, connectionId: connectionId || null }, transaction }); // M9-D229: o identificador é único por connection
    if (existing) {
      // Deduplicação de webhook — mesma mensagem externa reenviada não gera duplicata.
      return existing;
    }
  }

  // M9-D415: envio de automação leva a action_key; dois envios com a mesma chave resultam em uma mensagem (replay devolve a existente).
  const { record: message, replay } = await createOnceByActionKey(
    Message,
    {
      groupId,
      companyId,
      personId: personId || null,
      opportunityId: opportunityId || null,
      channel: normalizedChannel,
      direction: normalizedDirection,
      authorType: normalizedAuthorType,
      authorUserId: authorUserId || null,
      body: body || null,
      status: deliveryStatus || 'RECEIVED',
      externalMessageId: externalMessageId || null,
      connectionId: connectionId || null,
      dispatchId: dispatchId || null,
      deliveryStatus: deliveryStatus || null,
      actionKey: actionKey || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  if (replay) return message;

  // Caderno (seção 17, "Eventos mínimos"): crm.interaction.recorded — "Message" é a
  // implementação concreta de crm.interactions no sistema (ver Crm.md).
  await publishDomainEvent(
    {
      groupId,
      companyId,
      aggregateType: 'Message',
      aggregateId: message.id,
      eventType: 'crm.interaction.recorded',
      payload: { id: message.id, personId: message.personId, opportunityId: message.opportunityId, channel: message.channel, direction: message.direction },
      idempotencyKey: `crm.interaction.recorded:${message.id}`,
    },
    transaction
  );

  return message;
}

async function listMessages(transaction, filters = {}) {
  const where = {};
  if (filters.personId) where.personId = filters.personId;
  if (filters.opportunityId) where.opportunityId = filters.opportunityId;
  return Message.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getMessage(id, transaction) {
  const message = await Message.findByPk(id, { transaction });
  if (!message) throw AppError.notFound('Mensagem não encontrada.', 'MESSAGE_NOT_FOUND');
  return message;
}

async function updateMessageStatus(id, status, actorUserId, transaction, { fromProvider = false } = {}) {
  const message = await getMessage(id, transaction);
  // M9-D229: o status de entrega de mensagem que passou por fornecedor só muda por evidência dele (webhook ou consulta de status), nunca por edição manual.
  if (message.deliveryStatus && !fromProvider) {
    throw AppError.conflict('O status de entrega desta mensagem é confirmado pelo fornecedor e não pode ser alterado manualmente.', 'MESSAGE_STATUS_BY_PROVIDER_ONLY');
  }
  if (!status) {
    throw AppError.badRequest('O campo "status" é obrigatório.', 'MESSAGE_VALIDATION');
  }
  const previousStatus = message.status;
  message.status = String(status).toUpperCase();
  if (fromProvider) message.deliveryStatus = message.status;
  message.updatedBy = actorUserId || null;
  await message.save({ transaction });
  // M9-D627: o status de entrega muda os números do BI de Marketing (entregues e falhas do dia da mensagem); o dia é o de criação, em SP.
  if (message.direction === 'OUTBOUND' && previousStatus !== message.status) {
    await publishDomainEvent(
      {
        groupId: message.groupId,
        companyId: message.companyId,
        aggregateType: 'Message',
        aggregateId: message.id,
        eventType: 'crm.message.status_changed',
        payload: { id: message.id, channel: message.channel, status: message.status, day: businessDateKey(message.getDataValue('created_at')) },
        idempotencyKey: `crm.message.status_changed:${message.id}:${message.status}:${new Date(message.getDataValue('updated_at')).getTime()}`,
      },
      transaction
    );
  }
  return message;
}

module.exports = { createMessage, listMessages, getMessage, updateMessageStatus, DIRECTIONS, AUTHOR_TYPES, CHANNELS };
