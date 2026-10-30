'use strict';

const { CHANNELS, MODES } = require('../channels');
const channelRegistry = require('./channelRegistry');
const { SandboxChannelAdapter } = require('../sandbox/SandboxChannelAdapter');
const { RealChannelAdapter } = require('../real/RealChannelAdapter');

let installed = false;

/**
 * Registra os 9 canais em SANDBOX e em PRODUCTION. A fábrica de PRODUCTION exige a prova de liberação em `opts.proof`; quem a emite, só para canal
 * liberado, é channelAccess.
 */
function installChannelAdapters() {
  if (installed) return channelRegistry.list();
  installed = true;
  for (const channel of CHANNELS) {
    channelRegistry.register({ channel, mode: MODES.SANDBOX, create: (opts) => new SandboxChannelAdapter(channel, opts || {}) });
    channelRegistry.register({ channel, mode: MODES.PRODUCTION, create: (ctx, opts = {}) => new RealChannelAdapter(channel, ctx, opts) });
  }
  return channelRegistry.list();
}

module.exports = { installChannelAdapters };
