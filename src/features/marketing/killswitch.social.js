'use strict';

const { registerKillSwitchCheck } = require('../integrations/social/social.killswitch');
const { SOCIAL_CHANNELS } = require('./killswitch.constants');
const { readKillState, tenantFromContext } = require('./killswitch.state');

/**
 * Liga o kill switch geral ao gate de publicação em rede social (critério acrescentado pela M9-D239): além do kill switch da campanha, que o gate já lê, vale o global e o de canal.
 * O gate não sabe qual rede o envio usa (a rede é a conexão, resolvida depois); sem o canal no contexto basta UM canal social ligado para segurar o post (DI-D425-6). Com `channel`,
 * vale só ele. Estado ilegível segura o post (falha fechada). Chamado uma vez ao carregar a fachada.
 */
let unregister = null;
function registerSocialKillSwitchCheck() {
  if (unregister) return unregister;
  unregister = registerKillSwitchCheck(async ({ companyId, campaignId, channel, transaction }) => {
    const tenant = await tenantFromContext(companyId, transaction);
    const state = await readKillState(tenant, { channel: channel || SOCIAL_CHANNELS, campaignId }, transaction);
    return state.blocked;
  });
  return unregister;
}

module.exports = { registerSocialKillSwitchCheck };
