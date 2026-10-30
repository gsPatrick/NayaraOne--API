'use strict';

const { CHANNEL_META } = require('../channels');
const { normalizeChannel } = require('../channel.errors');
const { decideOnResult } = require('./channelContingency');
const logger = require('../../../../../utils/logger');

/**
 * Envia/publica para vários canais SEM que a falha de um bloqueie os outros (falha isolada por canal, M9-D430 3.8 / M9-D410). Cada pedido é
 * { channel, message, idempotencyKey, scenario? }; `adapterFor(canal)` entrega o adapter (o padrão do serviço é resolveChannelAdapter). Devolve, na
 * ordem dos pedidos, { channel, result, contingency }: adapter que lança vira result = null com a decisão de isolar e tentar de novo por classe.
 */
async function fanOut(requests, { adapterFor }) {
  const out = [];
  for (const request of requests) {
    const channel = normalizeChannel(request.channel);
    try {
      const adapter = await adapterFor(channel);
      const options = { idempotencyKey: request.idempotencyKey, ...(adapter.isSandbox && request.scenario ? { scenario: request.scenario } : {}) };
      const result = await adapter[CHANNEL_META[channel].operation](request.message, options);
      out.push({ channel, result, contingency: decideOnResult(channel, result) });
    } catch (err) {
      logger.warn({ channel, code: err && err.code }, 'marketing.channel.fanout.channel_failed');
      out.push({ channel, result: null, contingency: decideOnResult(channel, { status: 'FAILED', error: { class: 'TRANSIENT', code: 'ADAPTER_EXCEPTION' } }) });
    }
  }
  return out;
}

module.exports = { fanOut };
