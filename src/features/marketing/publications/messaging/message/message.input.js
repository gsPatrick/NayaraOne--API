'use strict';

const { invalidMessage } = require('./message.errors');

const CHANNELS = Object.freeze(['WHATSAPP', 'EMAIL']);
const TEXT_MAX = 20000;
const SUBJECT_MAX = 300;
const KEY_MAX = 200;

const isText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/**
 * Confere o pedido de envio (WhatsApp ou e-mail) antes de qualquer leitura: pessoa, canal, finalidade e chave de idempotência são obrigatórios.
 * `text` ou `templateId` precisa existir; e-mail precisa de assunto. Devolve o pedido normalizado.
 */
function parseSendInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidMessage('Dados inválidos para o envio.');
  const channel = String(input.channel || '').trim().toUpperCase();
  if (!CHANNELS.includes(channel)) throw invalidMessage('Canal inválido para mensagem direta.', { campo: 'channel', validos: CHANNELS });
  if (!isText(input.personId, 64)) throw invalidMessage('Informe a pessoa.', { campo: 'personId' });
  if (!isText(input.purpose, 40)) throw invalidMessage('Informe a finalidade.', { campo: 'purpose' });
  if (!isText(input.actionKey, KEY_MAX)) throw invalidMessage('Informe a chave de idempotência (actionKey).', { campo: 'actionKey' });
  if (input.text !== undefined && input.text !== null && !isText(input.text, TEXT_MAX)) throw invalidMessage('Texto inválido.', { campo: 'text' });
  if (!input.text && !input.templateId) throw invalidMessage('Informe o texto ou o template.', { campo: 'text' });
  if (channel === 'EMAIL' && !isText(input.subject, SUBJECT_MAX)) throw invalidMessage('Informe o assunto do e-mail.', { campo: 'subject' });
  if (input.preheader !== undefined && input.preheader !== null && !isText(input.preheader, SUBJECT_MAX)) throw invalidMessage('Pré-cabeçalho inválido.', { campo: 'preheader' });
  if (input.variables !== undefined && input.variables !== null && (typeof input.variables !== 'object' || Array.isArray(input.variables))) throw invalidMessage('Variáveis inválidas.', { campo: 'variables' });
  return {
    channel,
    personId: input.personId,
    purpose: String(input.purpose).trim().toUpperCase(),
    actionKey: input.actionKey,
    text: input.text ? String(input.text) : null,
    subject: input.subject ? String(input.subject).trim() : null,
    preheader: input.preheader ? String(input.preheader).trim() : null,
    templateId: input.templateId || null,
    variables: input.variables || {},
    sensitive: input.sensitive === true,
    portalUrl: typeof input.portalUrl === 'string' ? input.portalUrl : null,
    unsubscribeUrl: typeof input.unsubscribeUrl === 'string' ? input.unsubscribeUrl : null,
    opportunityId: input.opportunityId || null,
  };
}

module.exports = { parseSendInput, CHANNELS };
