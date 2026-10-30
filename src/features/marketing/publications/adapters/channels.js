'use strict';

/**
 * M9-D430 — os 9 canais do Marketing e o que cada um tem de próprio. Os nomes de operação são os do ChannelAdapter (send para mensagem direta,
 * publish para publicação); `metrics` são as métricas que o canal informa (vazio = o canal não tem getMetrics); `sandboxProvider` é o sandbox da
 * família no bloco B (framework de Integrações) em que o canal se apoia; `family` é o domínio da família no catálogo do bloco B.
 */
const CHANNELS = Object.freeze(['WHATSAPP', 'EMAIL', 'SITE', 'INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'TIKTOK', 'PORTAL']);

const social = (extra = {}) => ({ family: 'SOCIAL', operation: 'publish', resource: 'posts', sandboxProvider: 'social-sandbox', metrics: ['impressions', 'reach', 'engagements'], finalStatus: 'PUBLISHED', ...extra });

const CHANNEL_META = Object.freeze({
  WHATSAPP: { family: 'MESSAGING', operation: 'send', resource: 'messages', sandboxProvider: 'messaging-sandbox', metrics: ['delivered', 'read', 'replied'], finalStatus: 'DELIVERED' },
  EMAIL: { family: 'EMAIL', operation: 'send', resource: 'emails', sandboxProvider: 'email-sandbox', metrics: ['delivered', 'opened', 'clicked', 'bounced'], finalStatus: 'DELIVERED' },
  SITE: { family: 'SITE', operation: 'publish', resource: 'pages', sandboxProvider: 'site-sandbox', metrics: [], finalStatus: 'PUBLISHED' },
  INSTAGRAM: social(),
  FACEBOOK: social(),
  LINKEDIN: social(),
  YOUTUBE: social({ metrics: ['views', 'likes', 'comments'] }),
  TIKTOK: social({ metrics: ['views', 'likes', 'shares'] }),
  PORTAL: { family: 'PORTAL', operation: 'publish', resource: 'listings', sandboxProvider: 'portal-sandbox', metrics: ['views', 'contacts'], finalStatus: 'PUBLISHED' },
});

const MODES = Object.freeze({ SANDBOX: 'SANDBOX', PRODUCTION: 'PRODUCTION' });

/** Versão do contrato do ChannelAdapter: a homologação e o failure drill valem para a versão vigente. */
const ADAPTER_VERSION = 'v1';

/** Chave do parâmetro de liberação do canal (parametros.csv, MKT-P060). */
const releaseKey = (channel) => `marketing.channel.${String(channel).toLowerCase()}.liberado`;

module.exports = { CHANNELS, CHANNEL_META, MODES, ADAPTER_VERSION, releaseKey };
