'use strict';

// M9-D030 (critério vindo da M9-D041) — a rota POST /ai/agents/NAY_ATENDIMENTO/chat é a porta do CANAL (site, WhatsApp). Ela não trata o
// agente como um agente comum: chama `atendimentoChat` com a empresa do chamador e com o contato do CRM resolvido AQUI, pelo servidor, a
// partir do endereço do canal. O corpo nunca traz o id do contato (`externalContactId` enviado é ignorado) e o modelo também não o informa.
const { Op } = require('sequelize');
const { PersonContact } = require('../../../models');
const { prepareAtendimentoChat, AGENT_CODE } = require('../agents/nay_atendimento');
const { initToolRegistry } = require('../tools');
const E = require('./runApi.errors');
const { parseInput, parseKey } = require('./runApi.validation');

const CHANNEL_TYPES = Object.freeze(['PHONE', 'WHATSAPP', 'EMAIL']);
const ADDRESS_MAX = 254;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** O chat deste agente é o do canal? (código sem caixa, como nas demais rotas) */
const isAtendimento = (agentCode) => String(agentCode || '').trim().toUpperCase() === AGENT_CODE;

/** Corpo do canal: `message`, `idempotencyKey?` e `channel?: { type, address }` (de onde o servidor resolve o contato). */
function parseChannelBody(raw, inputMax) {
  const b = isObject(raw) ? raw : {};
  let channel = null;
  if (b.channel !== undefined && b.channel !== null) {
    const type = isObject(b.channel) && typeof b.channel.type === 'string' ? b.channel.type.trim().toUpperCase() : '';
    const address = isObject(b.channel) && typeof b.channel.address === 'string' ? b.channel.address.trim() : '';
    if (!CHANNEL_TYPES.includes(type) || !address || address.length > ADDRESS_MAX) {
      throw E.inputInvalid(`Informe o canal com type (${CHANNEL_TYPES.join(', ')}) e address.`);
    }
    channel = { type, address };
  }
  return { message: parseInput(b.message, inputMax), idempotencyKey: parseKey(b.idempotencyKey), channel };
}

/** Telefone só com dígitos; e-mail sem caixa. */
const normalizeAddress = (type, address) => (type === 'EMAIL' ? address.toLowerCase() : address.replace(/\D/g, ''));

/**
 * Contato do CRM dono do endereço do canal, NA EMPRESA do chamador (RLS). Nulo quando não há nenhum ou quando o endereço pertence a mais de
 * uma pessoa: o servidor não adivinha, e a conversa segue como contato desconhecido.
 */
async function resolveChannelContact(channel, transaction) {
  if (!channel) return null;
  const value = normalizeAddress(channel.type, channel.address);
  if (!value) return null;
  const types = channel.type === 'WHATSAPP' ? ['WHATSAPP', 'PHONE'] : [channel.type];
  const candidates = channel.type === 'EMAIL' ? [value] : [value, `+${value}`];
  const rows = await PersonContact.findAll({ where: { contactType: { [Op.in]: types }, valueNormalized: { [Op.in]: candidates } }, attributes: ['personId'], transaction });
  const people = [...new Set(rows.map((r) => r.personId))];
  return people.length === 1 ? people[0] : null;
}

/** Só o preparo do canal: o pedido e a identidade de serviço, sem executar (a rota abre o run e depois executa em outra transação). */
async function prepareChannelRequest({ body }, auth, transaction, deps = {}, inputMax) {
  const parsed = parseChannelBody(body, inputMax);
  const externalContactId = await resolveChannelContact(parsed.channel, transaction);
  const toolRegistry = deps.toolRegistry || await initToolRegistry();
  const prepared = await prepareAtendimentoChat({
    groupId: auth.groupId, companyId: auth.companyId, message: parsed.message, externalContactId, idempotencyKey: parsed.idempotencyKey,
  }, transaction);
  return { ...prepared, deps: { ...deps, toolRegistry } };
}

module.exports = { isAtendimento, prepareChannelRequest, resolveChannelContact, parseChannelBody };
