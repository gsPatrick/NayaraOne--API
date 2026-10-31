'use strict';

/**
 * M9-D402/D433 — portas da sequência de conta comprometida. A área de segurança não importa a de publicações (que importa a segurança em cada envio): quem monta o módulo
 * (marketing/index.js) registra aqui como resolver o adapter do canal, e qual é a família do canal no catálogo de Integrações. Sem registro, a sequência falha fechada.
 */
let channelPorts = null;

/** Registra { resolveChannelAdapter(channel, ctx), familyOf(channel) }. Passar null desfaz o registro. */
function registerChannelPorts(ports) {
  if (ports !== null && (!ports || typeof ports.resolveChannelAdapter !== 'function' || typeof ports.familyOf !== 'function')) {
    throw new TypeError('As portas de canal precisam de resolveChannelAdapter e familyOf.');
  }
  channelPorts = ports;
}

function ports() {
  if (!channelPorts) throw new Error('Portas de canal da área de segurança não registradas.');
  return channelPorts;
}

module.exports = { registerChannelPorts, ports };
