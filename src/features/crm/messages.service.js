'use strict';

const { Message, Person, Opportunity } = require('../../models');
const AppError = require('../../utils/AppError');
const { withScope } = require('./carteira/carteira.scope');
const { canContact } = require('../people/personConsents.service');
const { resolveOutboundPurpose } = require('./messagePurpose');
const { publishDomainEvent } = require('../../engines/events/outbox');
const { createOnceByActionKey } = require('../../utils/createOnceByActionKey');
const { businessDateKey } = require('../../utils/businessDate');
const { describeMedia } = require('./messaging/whatsapp.mediaView');
const { assertConversationRefsInScope } = require('./messages.refs');
const { idOrNull, textOrNull, oneOf, actionKeyOrNull } = require('./messages.input');
const { DIRECTIONS, AUTHOR_TYPES, CHANNELS, DELIVERY_STATUSES, MESSAGE_STATUSES, PURPOSE, COLUMN_LIMITS } = require('./messages.constants');

/** Finalidade (M9-D230): só texto (objeto ou lista é 400; o String() dava 500). Vazio é "sem finalidade". */
function purposeText(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw AppError.badRequest('O campo "purpose" deve ser um texto.', 'MESSAGE_VALIDATION');
  return value;
}

/** Guia §10 occurredAt: quando o contato aconteceu. Data válida e não no futuro (tolerância de 5 minutos de relógio). */
function parseOccurredAt(value) {
  if (value === undefined || value === null || value === '') return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw AppError.badRequest('O campo "occurredAt" precisa ser uma data válida.', 'MESSAGE_VALIDATION');
  if (date.getTime() > Date.now() + 5 * 60 * 1000) throw AppError.badRequest('O campo "occurredAt" não pode estar no futuro.', 'MESSAGE_VALIDATION');
  return date;
}

/**
 * "crm"."messages" não tem `deleted_at`/paranoid no model (ver src/models/Message.js) — é
 * append-only por design (histórico de atendimento nunca é apagado). Este service expõe
 * apenas create/list/get e uma atualização restrita de `status` (ex.: RECEIVED -> READ),
 * nunca delete nem edição de `body`.
 */
async function createMessage(payload, actorUserId, transaction) {
  const { groupId, companyId, channel, direction, authorType } = payload;
  const occurredAt = parseOccurredAt(payload.occurredAt);

  if (!groupId || !companyId || !direction || !authorType) {
    throw AppError.badRequest('Os campos "groupId", "companyId", "direction" e "authorType" são obrigatórios.', 'MESSAGE_VALIDATION');
  }
  // Rodada 4 (DI-M9R-8): forma de cada campo de referência ANTES de qualquer consulta; lista, objeto ou número é 400, nunca 500.
  const personId = idOrNull(payload.personId, 'personId');
  const opportunityId = idOrNull(payload.opportunityId, 'opportunityId');
  const conversationId = idOrNull(payload.conversationId, 'conversationId');
  const mediaQuarantineId = idOrNull(payload.mediaQuarantineId, 'mediaQuarantineId');
  const authorUserId = idOrNull(payload.authorUserId, 'authorUserId');
  const connectionId = idOrNull(payload.connectionId, 'connectionId');
  const dispatchId = idOrNull(payload.dispatchId, 'dispatchId');
  const externalMessageId = textOrNull(payload.externalMessageId, 'externalMessageId', COLUMN_LIMITS.externalMessageId);
  // Rodada 5 (DI-M9R-11 e 12): a chave só no formato da CHECK da migration 755, e as listas fechadas só em texto (o String() de antes dava 500 com {"toString": 1}).
  const actionKey = actionKeyOrNull(payload.actionKey);
  const body = textOrNull(payload.body, 'body');
  const normalizedDirection = oneOf(direction, 'direction', DIRECTIONS);
  const normalizedAuthorType = oneOf(authorType, 'authorType', AUTHOR_TYPES);
  const normalizedChannel = oneOf(channel, 'channel', CHANNELS, 'WHATSAPP');
  const purpose = purposeText(payload.purpose);
  const deliveryStatus = oneOf(payload.deliveryStatus, 'deliveryStatus', DELIVERY_STATUSES);

  let person = null;
  if (personId) {
    person = await Person.findByPk(personId, { transaction });
    if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  }
  // ISO-R2: conversa e mídia em quarentena só da empresa da mensagem (404 fora do escopo, antes do consentimento e de gravar).
  await assertConversationRefsInScope({ companyId, conversationId, mediaQuarantineId }, transaction);

  // Bloqueio ATIVO de opt-out (Guia do Marcelo §11/§18 "Não ignorar opt-out.";
  // CRM-TS-009 "Opt-out — Cadência tenta enviar — Bloqueado."). Só se aplica a envio SAÍDO
  // (OUTBOUND) para uma pessoa identificada — mensagem recebida do cliente (INBOUND) nunca é
  // bloqueada por consentimento (o cliente está livre pra falar com a empresa mesmo tendo
  // pedido pra não ser contatado).
  // M3-18: mensagem SAÍDA para pessoa identificada declara a finalidade, que precisa estar na lista única da empresa; nunca vira
  // TRANSACTIONAL por omissão (crm/messagePurpose.js).
  const finalPurpose = await resolveOutboundPurpose({ direction: normalizedDirection, personId: person ? person.id : null, purpose }, { groupId, companyId }, transaction);
  if (person && normalizedDirection === 'OUTBOUND') {
    const allowed = await canContact(person, normalizedChannel, finalPurpose, transaction);
    if (!allowed) {
      throw AppError.unprocessable(
        'Envio bloqueado: a pessoa optou por não receber contato (opt-out) neste canal/finalidade, ou a finalidade exige opt-in explícito ausente.',
        'MESSAGE_BLOCKED_BY_CONSENT',
        { personId, channel: normalizedChannel, purpose: finalPurpose }
      );
    }
  }

  if (opportunityId) {
    const opportunity = await Opportunity.findByPk(opportunityId, { transaction });
    if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
  }

  if (externalMessageId) {
    // M9-D229: o identificador é único por connection; sem connection, por empresa (DI-M9R-10, migration 20260101009976). A empresa vai explícita
    // (além do RLS): a deduplicação só devolve mensagem da própria empresa, e o mesmo id em outra empresa é outra mensagem.
    const existing = await Message.findOne({ where: { companyId, externalMessageId, connectionId: connectionId || null }, transaction });
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
      occurredAt,
      status: deliveryStatus || 'RECEIVED',
      externalMessageId: externalMessageId || null,
      connectionId: connectionId || null,
      dispatchId: dispatchId || null,
      deliveryStatus: deliveryStatus || null,
      conversationId: conversationId || null,
      mediaQuarantineId: mediaQuarantineId || null,
      purpose: finalPurpose, // M9-D230 / M3-18: a finalidade fica na mensagem; o consentimento é conferido de novo no envio
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
  const personId = idOrNull(filters.personId, 'personId'); // DI-M9R-8: `?personId[a]=b` ou lista na query também é 400, nunca 500
  const opportunityId = idOrNull(filters.opportunityId, 'opportunityId');
  if (personId) where.personId = personId;
  if (opportunityId) where.opportunityId = opportunityId;
  // CRM-TS-012: o corretor de escopo próprio só lista mensagens da carteira (filters.carteira vem da rota).
  return describeMedia(await Message.findAll({ where: withScope(where, 'message', filters.carteira), order: [['created_at', 'DESC']], transaction }), transaction);
}

async function getMessage(id, transaction) {
  const message = await Message.findByPk(id, { transaction });
  if (!message) throw AppError.notFound('Mensagem não encontrada.', 'MESSAGE_NOT_FOUND');
  return message;
}

async function updateMessageStatus(id, status, actorUserId, transaction, { fromProvider = false } = {}) {
  // Rodada 5 (DI-M9R-11 e 13): só um status da lista fechada, em texto, antes de qualquer outra regra. Sem isso, texto acima de 32 caracteres ia ao
  // varchar(32) e `{"toString": 1}` ao String() (500), e `{}`/`[]`/`true` eram gravados como "[OBJECT OBJECT]", "" e "TRUE".
  if (status === undefined || status === null || status === '') throw AppError.badRequest('O campo "status" é obrigatório.', 'MESSAGE_VALIDATION');
  const nextStatus = oneOf(status, 'status', MESSAGE_STATUSES);
  const message = await getMessage(id, transaction);
  // M9-D229: o status de entrega de mensagem que passou por fornecedor só muda por evidência dele (webhook ou consulta de status), nunca por edição manual.
  if (message.deliveryStatus && !fromProvider) {
    throw AppError.conflict('O status de entrega desta mensagem é confirmado pelo fornecedor e não pode ser alterado manualmente.', 'MESSAGE_STATUS_BY_PROVIDER_ONLY');
  }
  const previousStatus = message.status;
  message.status = nextStatus;
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

module.exports = { createMessage, listMessages, getMessage, updateMessageStatus, DIRECTIONS, AUTHOR_TYPES, CHANNELS, MESSAGE_STATUSES };
