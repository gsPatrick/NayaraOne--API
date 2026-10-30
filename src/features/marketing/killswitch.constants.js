'use strict';

const { CHANNELS } = require('./publications/adapters/channels');

/**
 * Constantes do kill switch do Marketing (M9-D425). Quatro escopos; GLOBAL e CHANNEL moram no registro de flags (M9-D870/D872) como kill switch com probe,
 * CAMPAIGN e AUTOMATION nas colunas kill_switch_* da campanha e do fluxo. Listas fechadas do livro (Caderno §8); o que varia por empresa é parâmetro.
 */
const SCOPES = Object.freeze({ GLOBAL: 'GLOBAL', CHANNEL: 'CHANNEL', CAMPAIGN: 'CAMPAIGN', AUTOMATION: 'AUTOMATION' });
const ACTIONS = Object.freeze({ ACTIVATE: 'ACTIVATE', RESTORE: 'RESTORE' });
const SOURCES = Object.freeze({ MANUAL: 'MANUAL', INCIDENT_CRITICAL: 'INCIDENT_CRITICAL', COMPROMISED_ACCOUNT: 'COMPROMISED_ACCOUNT' });

const GLOBAL_KEY = 'marketing.sending.kill';
const channelKey = (channel) => `marketing.channel.${String(channel).toLowerCase()}.kill`;
const CHANNEL_KEYS = Object.freeze(CHANNELS.map(channelKey));
const REGISTRY_KEYS = Object.freeze([GLOBAL_KEY, ...CHANNEL_KEYS]);
/** Canais de rede social: o gate de publicação social não sabe a rede, então vale qualquer um deles ligado (DI-D425-6). */
const SOCIAL_CHANNELS = Object.freeze(['INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'TIKTOK']);

const PROBE_NAME = 'marketing.kill.envio_parado';
const PROBE_VERSION = '1';

const AUDIT = Object.freeze({ changed: 'marketing.kill_switch.changed', entity: 'marketing.kill_switch' });
const BLOCK_REASONS = Object.freeze({ GLOBAL: 'GLOBAL', CHANNEL: 'CHANNEL', CAMPAIGN: 'CAMPAIGN', AUTOMATION: 'AUTOMATION', UNREADABLE: 'STATE_UNREADABLE' });

module.exports = {
  SCOPES, ACTIONS, SOURCES, GLOBAL_KEY, channelKey, CHANNEL_KEYS, REGISTRY_KEYS, SOCIAL_CHANNELS, PROBE_NAME, PROBE_VERSION, AUDIT, BLOCK_REASONS,
};
