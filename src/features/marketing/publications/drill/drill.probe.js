'use strict';

const channelRegistry = require('../adapters/registry/channelRegistry');
const { SandboxChannelAdapter } = require('../adapters/sandbox/SandboxChannelAdapter');

/**
 * M9-D442 — sonda de chamadas ao provedor: troca o sandbox do canal por uma subclasse idêntica que apenas CONTA as chamadas de envio/publicação (e as consultas por chave) e
 * devolve a função que restaura o original. É assim que o ensaio prova "nenhuma chamada ao canal" com o circuito aberto, e "uma única chamada de teste" na meia-abertura.
 */
function installCallCounter(channel) {
  const original = channelRegistry.get(channel, 'SANDBOX');
  const counter = { sends: 0, lookups: 0 };
  class Counting extends SandboxChannelAdapter {
    execute(operation, payload, options) { counter.sends += 1; return super.execute(operation, payload, options); }

    findByIdempotencyKey(key) { counter.lookups += 1; return super.findByIdempotencyKey(key); }
  }
  channelRegistry.register({ channel, mode: 'SANDBOX', create: (opts) => new Counting(channel, opts || {}) });
  return { counter, restore: () => channelRegistry.register(original) };
}

module.exports = { installCallCounter };
