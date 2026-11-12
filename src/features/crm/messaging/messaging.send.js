'use strict';

const { Person, Opportunity } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const dispatchService = require('../../integrations/dispatch/enqueue/dispatch.service');
const { resolveConnection } = require('../../integrations/registry/connections.resolve');
const adapterRegistry = require('../../integrations/registry/adapterRegistry');
const { createMessage } = require('../messages.service');
const { assertConversationRefsInScope } = require('../messages.refs');
const { idOrNull } = require('../messages.input');
const { readMessagingParams } = require('./messaging.params');
const { assertE164 } = require('./messaging.phone');
const { readWhatsappParams } = require('./whatsapp.params');
const { assertConsent } = require('./whatsapp.consent');
const { assertTemplate } = require('./whatsapp.templates');
const { prepareOutboundMedia } = require('./whatsapp.media');
const { ensureConversation, assertSessionWindow } = require('./whatsapp.conversation');

const OPERATIONS = Object.freeze({ text: 'sendText', template: 'sendTemplate', media: 'sendMedia' });

const invalid = (message) => AppError.badRequest(message, 'MESSAGE_VALIDATION');

/**
 * Pessoa, oportunidade e conversa do pedido precisam existir no escopo de quem chama (RLS da empresa da sessão; a conversa também pela empresa explícita). Fora dele: 404 com o
 * código das outras rotas (PERSON_NOT_FOUND, OPPORTUNITY_NOT_FOUND, CONVERSATION_NOT_FOUND), antes de qualquer outra regra: a pessoa de outra empresa nunca é tratada como "sem
 * consentimento" (403) nem ganha conversa, e a conversa de outra empresa nunca chega à resolução da conexão (ISO-R2).
 */
async function assertRefsInScope(ctx, input, transaction) {
  // Rodada 4 (DI-M9R-8): a forma vem antes da consulta; lista ou objeto em qualquer um dos três é 400 MESSAGE_VALIDATION, nunca 500.
  const personId = idOrNull(input.personId, 'personId');
  const opportunityId = idOrNull(input.opportunityId, 'opportunityId');
  const conversationId = idOrNull(input.conversationId, 'conversationId');
  if (personId && !(await Person.findByPk(personId, { transaction, attributes: ['id'] }))) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  if (opportunityId && !(await Opportunity.findByPk(opportunityId, { transaction, attributes: ['id'] }))) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
  await assertConversationRefsInScope({ companyId: ctx.companyId, conversationId }, transaction);
}

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

function buildPayload(input, operation, degraded, recipientName, conversationId, media) {
  const base = { to: input.to, ...(recipientName ? { recipientName } : {}), ...(conversationId ? { conversationId } : {}) };
  if (operation === 'sendTemplate') return { ...base, templateName: input.templateName, ...(input.language ? { language: input.language } : {}), ...(input.templateVars ? { templateVars: input.templateVars } : {}) };
  if (operation === 'sendMedia') return { ...base, mediaRef: media.fileId, mediaClassification: media.classification, mimeType: media.mimeType, ...(input.caption ? { caption: input.caption } : {}) };
  const texto = degraded ? [input.caption, `[arquivo: ${media.fileName}]`].filter(Boolean).join('\n') : input.text;
  return { ...base, text: texto };
}

/**
 * sendMessage — o CRM pede "enviar mensagem a este contato" sem saber qual fornecedor há por baixo (M9-D229 3.2 item 1). Valida o telefone (E.164), resolve a connection da
 * família MESSAGING, grava a mensagem do CRM como `QUEUED` (opt-out e consentimento valem, como em toda mensagem) e enfileira o envio pelo Dispatch Service NA MESMA transação; quem
 * chama o fornecedor é o worker. A mensagem só avança para SENT quando o envio é aceito com o id do fornecedor e para DELIVERED/READ por webhook ou consulta de status.
 * `input`: kind (text|template|media), personId, opportunityId, to, text | templateName, language, templateVars | mediaRef (id do arquivo em files), caption, purpose.
 * Regras do WhatsApp (M9-D230), todas antes de gravar ou enfileirar qualquer coisa: modelo aprovado e variáveis conferidas, consentimento do contato (403), janela de atendimento para texto e mídia (422)
 * e mídia só de arquivo limpo, classificado, do tipo e do tamanho que o canal aceita. `opts.auth` é quem pede (acesso ao arquivo da mídia); sem ele vale a empresa sem permissões extras.
 */
async function sendMessage(ctx, input, actorUserId, transaction, opts = {}) {
  const pedido = input || {};
  const operacaoPedida = checkInput(pedido);
  await assertRefsInScope(ctx, pedido, transaction);
  const params = await readMessagingParams(ctx, transaction);
  const wa = await readWhatsappParams(ctx, transaction);
  const to = assertE164(pedido.to, params.countryCode);
  const connection = await resolveConnection({ companyId: ctx.companyId, domain: 'MESSAGING' }, transaction);
  if (pedido.kind === 'template') assertTemplate(connection, pedido);
  await assertConsent(pedido.personId || null, pedido.purpose, wa, transaction);
  const conversa = pedido.personId ? await ensureConversation(ctx, pedido.personId, { connection, externalConversationId: to }, transaction) : null; // a conversa é da pessoa, não do fornecedor: sobrevive à troca de provider (M9-D221)
  if (pedido.kind !== 'template') assertSessionWindow(conversa, wa);
  const media = pedido.kind === 'media' ? await prepareOutboundMedia({ auth: (opts && opts.auth) || { ...ctx, userId: actorUserId || ctx.userId, permissions: [] }, fileId: pedido.mediaRef, params: wa, transaction }) : null;
  const { operation, degraded } = chooseOperation(connection, operacaoPedida);
  const pessoa = pedido.personId ? await Person.findByPk(pedido.personId, { transaction }) : null;
  const conversationId = conversa ? conversa.id : (pedido.conversationId || null);
  const historico = pedido.kind === 'text' ? pedido.text : (pedido.kind === 'template' ? `[template ${pedido.templateName}]` : (pedido.caption || `[mídia ${media.fileName}]`));
  const message = await createMessage({
    groupId: ctx.groupId, companyId: ctx.companyId, personId: pedido.personId || null, opportunityId: pedido.opportunityId || null, channel: 'WHATSAPP', direction: 'OUTBOUND',
    authorType: actorUserId ? 'EMPLOYEE' : 'NAY', authorUserId: actorUserId || null, body: historico, purpose: pedido.purpose || undefined, connectionId: connection.id, deliveryStatus: 'QUEUED', conversationId,
  }, actorUserId, transaction);
  const { dispatch } = await dispatchService.enqueue({
    companyId: ctx.companyId, connectionId: connection.id, operation, aggregateType: 'Message', aggregateId: message.id,
    payload: buildPayload({ ...pedido, to }, operation, degraded, pessoa ? (pessoa.preferredName || pessoa.legalName) : null, conversationId, media),
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
