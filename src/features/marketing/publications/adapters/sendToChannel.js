'use strict';

const { CHANNEL_META } = require('./channels');
const { normalizeChannel } = require('./channel.errors');
const { resolveChannelAdapter } = require('./release/channelAccess');
const { decideOnResult } = require('./contingency/channelContingency');
const { assertOutboundAllowed } = require('../../killswitch.state');

/**
 * Porta de saída do Marketing para um canal: escolhe o adapter pela liberação (sandbox enquanto o canal não está liberado; produção só depois, e
 * 409 MKT_CHANNEL_NOT_RELEASED se alguém pedir produção antes), executa send/publish com a chave de idempotência e junta a decisão de contingência do
 * canal. O resultado vem marcado sandbox = true/false: o simulado nunca é confundido com envio real. `scenario` só vale no sandbox (o real recusa).
 * KILL SWITCH (M9-D425): antes de qualquer outra coisa, global, canal, `campaignId` e `automationId` (quando a ação tem) são lidos na hora, sem cache; basta UM ligado, ou o estado
 * ilegível, para a saída ser recusada com 423 MKT_KILL_SWITCH_ACTIVE e nenhum adapter ser sequer resolvido.
 */
async function sendToChannel(channelName, message, { tenant, transaction, idempotencyKey, mode = 'AUTO', scenario, campaignId, automationId, media } = {}) {
  const channel = normalizeChannel(channelName);
  await assertOutboundAllowed(tenant, { channel, campaignId, automationId }, transaction);
  const adapter = await resolveChannelAdapter(channel, { tenant, transaction, mode });
  const options = { idempotencyKey, ...(scenario ? { scenario } : {}), ...(media ? { media } : {}) }; // media: resumo da mídia do conteúdo (M9-D428), conferido pelo adapter da rede
  const result = await adapter[CHANNEL_META[channel].operation](message, options);
  return { ...result, contingency: decideOnResult(channel, result) };
}

module.exports = { sendToChannel };
