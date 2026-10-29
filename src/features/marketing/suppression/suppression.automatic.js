'use strict';

const { readOptOutWords } = require('./suppression.settings');
const { suppress } = require('./suppression.service');

/** Compara a resposta da pessoa com as palavras de opt-out: sem acento, sem pontuação, maiúsculas, mensagem inteira. */
function normalizeReply(text) {
  return String(text === undefined || text === null ? '' : text).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Resposta recebida por um canal (M9-D429 chama aqui): se for SAIR, PARAR, STOP ou CANCELAR (palavras do parâmetro
 * `marketing.suppression.palavras_opt_out`), cria a supressão imediata de todas as finalidades daquele canal.
 */
async function handleInboundReply({ personId, channel, text, actor }, tenant, transaction) {
  const words = (await readOptOutWords(tenant, transaction)).map(normalizeReply);
  if (!words.includes(normalizeReply(text))) return { suppressed: false };
  const result = await suppress({ personId, channel, reason: 'OPT_OUT', source: `INBOUND_REPLY:${String(channel).toUpperCase()}`, actor }, tenant, transaction);
  return { suppressed: true, ...result };
}

const handleUnsubscribeLink = ({ personId, channel, actor }, tenant, transaction) => suppress({ personId, channel, reason: 'OPT_OUT', source: 'UNSUBSCRIBE_LINK', actor }, tenant, transaction);
const handlePermanentBounce = ({ personId, channel, actor }, tenant, transaction) => suppress({ personId, channel, reason: 'BOUNCE', source: 'PERMANENT_BOUNCE', actor }, tenant, transaction);
const handleSpamComplaint = ({ personId, channel, actor }, tenant, transaction) => suppress({ personId, channel, reason: 'COMPLAINT', source: 'SPAM_COMPLAINT', actor }, tenant, transaction);
const handleInvalidNumber = ({ personId, channel, actor }, tenant, transaction) => suppress({ personId, channel, reason: 'BOUNCE', source: 'INVALID_NUMBER', actor }, tenant, transaction);

module.exports = { handleInboundReply, handleUnsubscribeLink, handlePermanentBounce, handleSpamComplaint, handleInvalidNumber, normalizeReply };
