'use strict';

const { Message, Person, Opportunity } = require('../../models');
const AppError = require('../../utils/AppError');

const DIRECTIONS = ['INBOUND', 'OUTBOUND'];
const AUTHOR_TYPES = ['CLIENT', 'NAY', 'EMPLOYEE'];

/**
 * "crm"."messages" não tem `deleted_at`/paranoid no model (ver src/models/Message.js) — é
 * append-only por design (histórico de atendimento nunca é apagado). Este service expõe
 * apenas create/list/get e uma atualização restrita de `status` (ex.: RECEIVED -> READ),
 * nunca delete nem edição de `body`.
 */
async function createMessage(payload, actorUserId, transaction) {
  const { groupId, companyId, personId, opportunityId, channel, direction, authorType, authorUserId, body, externalMessageId } = payload;

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

  if (personId) {
    const person = await Person.findByPk(personId, { transaction });
    if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  }
  if (opportunityId) {
    const opportunity = await Opportunity.findByPk(opportunityId, { transaction });
    if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
  }

  if (externalMessageId) {
    const existing = await Message.findOne({ where: { externalMessageId }, transaction });
    if (existing) {
      // Deduplicação de webhook — mesma mensagem externa reenviada não gera duplicata.
      return existing;
    }
  }

  return Message.create(
    {
      groupId,
      companyId,
      personId: personId || null,
      opportunityId: opportunityId || null,
      channel: channel ? String(channel).toUpperCase() : 'WHATSAPP',
      direction: normalizedDirection,
      authorType: normalizedAuthorType,
      authorUserId: authorUserId || null,
      body: body || null,
      status: 'RECEIVED',
      externalMessageId: externalMessageId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
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

async function updateMessageStatus(id, status, actorUserId, transaction) {
  const message = await getMessage(id, transaction);
  if (!status) {
    throw AppError.badRequest('O campo "status" é obrigatório.', 'MESSAGE_VALIDATION');
  }
  message.status = String(status).toUpperCase();
  message.updatedBy = actorUserId || null;
  await message.save({ transaction });
  return message;
}

module.exports = { createMessage, listMessages, getMessage, updateMessageStatus, DIRECTIONS, AUTHOR_TYPES };
