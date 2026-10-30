'use strict';

const { CHANNELS, MODES } = require('../channels');
const { invalid } = require('../channel.errors');
const { capabilitiesForChannel } = require('../ChannelAdapter');

/**
 * Registry dos adapters de canal do Marketing: (canal, modo) -> fábrica. Todo adapter nasce registrado com o seu `mode` (SANDBOX ou PRODUCTION); o
 * registry das conexões, dos fornecedores e do circuit breaker continua sendo o do bloco B (esta camada não o recria).
 */
const entries = new Map();
const keyOf = (channel, mode) => `${channel}|${mode}`;

function register({ channel, mode, create }) {
  if (!CHANNELS.includes(channel)) throw invalid('Canal desconhecido.', { campo: 'channel' });
  if (!Object.values(MODES).includes(mode)) throw invalid('Modo de adapter desconhecido.', { campo: 'mode' });
  if (typeof create !== 'function') throw new TypeError('o adapter de canal precisa de uma fábrica');
  entries.set(keyOf(channel, mode), { channel, mode, create });
}

function get(channel, mode) {
  const entry = entries.get(keyOf(String(channel).toUpperCase(), mode));
  if (!entry) throw invalid('Adapter de canal não registrado.', { channel, mode });
  return entry;
}

const list = () => [...entries.values()].map(({ channel, mode }) => ({ channel, mode, capabilities: capabilitiesForChannel(channel) }));

module.exports = { register, get, list };
