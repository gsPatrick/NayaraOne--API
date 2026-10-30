'use strict';

const { CHANNELS, MODES } = require('../channels');
const channelRegistry = require('./channelRegistry');
const { SandboxChannelAdapter } = require('../sandbox/SandboxChannelAdapter');
const { RealChannelAdapter } = require('../real/RealChannelAdapter');
const social = require('../social');

let installed = false;

/**
 * Registra os 9 canais em SANDBOX e em PRODUCTION (as cinco redes sociais com o adapter próprio da M9-D428). A fábrica de PRODUCTION exige a prova de liberação em `opts.proof`; quem a emite, só para canal
 * liberado, é channelAccess.
 */
function installChannelAdapters() {
  if (installed) return channelRegistry.list();
  installed = true;
  for (const channel of CHANNELS) {
    // M9-D428: cada rede social tem o seu adapter (regras, capabilities e marca de idempotência próprias); os demais canais usam o genérico da M9-D430.
    const Sandbox = social.SANDBOX_ADAPTERS[channel] || SandboxChannelAdapter;
    const Real = social.REAL_ADAPTERS[channel] || RealChannelAdapter;
    channelRegistry.register({ channel, mode: MODES.SANDBOX, create: (opts) => new Sandbox(channel, opts || {}) });
    channelRegistry.register({ channel, mode: MODES.PRODUCTION, create: (ctx, opts = {}) => new Real(channel, ctx, opts) });
  }
  return channelRegistry.list();
}

module.exports = { installChannelAdapters };
