'use strict';

const { CHANNEL_META } = require('./channels');
const { normalizeChannel } = require('./channel.errors');
const { resolveChannelAdapter } = require('./release/channelAccess');
const { decideOnResult } = require('./contingency/channelContingency');

/**
 * Porta de saída do Marketing para um canal: escolhe o adapter pela liberação (sandbox enquanto o canal não está liberado; produção só depois, e
 * 409 MKT_CHANNEL_NOT_RELEASED se alguém pedir produção antes), executa send/publish com a chave de idempotência e junta a decisão de contingência do
 * canal. O resultado vem marcado sandbox = true/false: o simulado nunca é confundido com envio real. `scenario` só vale no sandbox (o real recusa).
 */
async function sendToChannel(channelName, message, { tenant, transaction, idempotencyKey, mode = 'AUTO', scenario } = {}) {
  const channel = normalizeChannel(channelName);
  const adapter = await resolveChannelAdapter(channel, { tenant, transaction, mode });
  const options = { idempotencyKey, ...(scenario ? { scenario } : {}) };
  const result = await adapter[CHANNEL_META[channel].operation](message, options);
  return { ...result, contingency: decideOnResult(channel, result) };
}

module.exports = { sendToChannel };
