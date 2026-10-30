'use strict';

const { Person } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const dispatchService = require('../../integrations/dispatch/enqueue/dispatch.service');
const { resolveConnection } = require('../../integrations/registry/connections.resolve');
const adapterRegistry = require('../../integrations/registry/adapterRegistry');
const { createMessage } = require('../messages.service');
const { readMessagingParams } = require('./messaging.params');
const { assertE164 } = require('./messaging.phone');

const OPERATIONS = Object.freeze({ text: 'sendText', template: 'sendTemplate', media: 'sendMedia' });

const invalid = (message) => AppError.badRequest(message, 'MESSAGE_VALIDATION');

/** Corpo mínimo por tipo de envio (os campos que o port exige) e o texto que fica no histórico do CRM. */
function checkInput(input) {
  const operation = OPERATIONS[input.kind];
  if (!operation) throw invalid('O campo "kind" deve ser um de: text, template, media.');
  if (input.kind === 'text' && !(typeof input.text === 'string' && input.text.trim())) throw invalid('O campo "text" é obrigatório para envio de texto.');
  if (input.kind === 'template' && !(typeof input.templateName === 'string' && input.templateName.trim())) throw invalid('O campo "templateName" é obrigatório para envio de template.');
  if (input.kind === 'media' && !(typeof input.mediaRef === 'string' && input.mediaRef.trim())) throw invalid('O campo "mediaRef" é obrigatório para envio de mídia.');
  return operation;
}

/** Operação efetiva: mídia num fornecedor sem sendMedia degrada de forma declarada para texto com a referência (M9-D221 3.3), nunca falha. */
function chooseOperation(connection, operation) {
  const adapter = adapterRegistry.instantiate(connection.providerCode);
  if (operation === 'sendMedia' && adapter && !adapter.supports('sendMedia') && adapter.supports('sendText')) return { operation: 'sendText', degraded: true };
  return { operation, degraded: false };
}

function buildPayload(input, operation, degraded, recipientName, conversationId) {
  const base = { to: input.to, ...(recipientName ? { recipientName } : {}), ...(conversationId ? { conversationId } : {}) };
  if (operation === 'sendTemplate') return { ...base, templateName: input.templateName, ...(input.language ? { language: input.language } : {}), ...(input.templateVars ? { templateVars: input.templateVars } : {}) };
  if (operation === 'sendMedia') return { ...base, mediaRef: input.mediaRef, mediaClassification: input.mediaClassification, ...(input.caption ? { caption: input.caption } : {}), ...(input.mimeType ? { mimeType: input.mimeType } : {}) };
  const texto = degraded ? [input.caption, input.mediaRef].filter(Boolean).join('\n') : input.text;
  return { ...base, text: texto };
}

/**
 * sendMessage — o CRM pede "enviar mensagem a este contato" sem saber qual fornecedor há por baixo (M9-D229 3.2 item 1). Valida o telefone (E.164), resolve a connection da
 * família MESSAGING, grava a mensagem do CRM como `QUEUED` (opt-out e consentimento valem, como em toda mensagem) e enfileira o envio pelo Dispatch Service NA MESMA transação; quem
 * chama o fornecedor é o worker. A mensagem só avança para SENT quando o envio é aceito com o id do fornecedor e para DELIVERED/READ por webhook ou consulta de status.
 * `input`: kind (text|template|media), personId, opportunityId, to, text | templateName, language, templateVars | mediaRef, mimeType, caption, conversationId, purpose.
 */
async function sendMessage(ctx, input, actorUserId, transaction) {
  const pedido = input || {};
  const operacaoPedida = checkInput(pedido);
  const params = await readMessagingParams(ctx, transaction);
  const to = assertE164(pedido.to, params.countryCode);
  const connection = await resolveConnection({ companyId: ctx.companyId, domain: 'MESSAGING' }, transaction);
  const { operation, degraded } = chooseOperation(connection, operacaoPedida);
  const pessoa = pedido.personId ? await Person.findByPk(pedido.personId, { transaction }) : null;
  const conversationId = pedido.conversationId || pedido.personId || null; // a conversa é da pessoa, não do fornecedor: sobrevive à troca de provider (M9-D221)
  const historico = pedido.kind === 'text' ? pedido.text : (pedido.kind === 'template' ? `[template ${pedido.templateName}]` : (pedido.caption || `[mídia ${pedido.mediaRef}]`));
  const message = await createMessage({
    groupId: ctx.groupId, companyId: ctx.companyId, personId: pedido.personId || null, opportunityId: pedido.opportunityId || null, channel: 'WHATSAPP', direction: 'OUTBOUND',
    authorType: actorUserId ? 'EMPLOYEE' : 'NAY', authorUserId: actorUserId || null, body: historico, purpose: pedido.purpose || undefined, connectionId: connection.id, deliveryStatus: 'QUEUED',
  }, actorUserId, transaction);
  const { dispatch } = await dispatchService.enqueue({
    companyId: ctx.companyId, connectionId: connection.id, operation, aggregateType: 'Message', aggregateId: message.id,
    payload: buildPayload({ ...pedido, to }, operation, degraded, pessoa ? (pessoa.preferredName || pessoa.legalName) : null, conversationId),
    idempotencyKey: `crm-message:${message.id}`, userId: actorUserId || null, transaction,
  });
  await message.update({ dispatchId: dispatch.id }, { transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: actorUserId || null, action: 'crm.message.send', entityType: 'Message', entityId: message.id,
    afterJson: { dispatchId: dispatch.id, operation, degraded, deliveryStatus: 'QUEUED' }, reason: `Envio agendado (${operation}${degraded ? ', mídia degradada para texto' : ''}) pela connection ${connection.id}.`,
  }, transaction);
  return { message, dispatchId: dispatch.id, operation, degraded, status: 'QUEUED' };
}

module.exports = { sendMessage, OPERATIONS };
