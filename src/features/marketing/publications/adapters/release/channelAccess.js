'use strict';

const { getSetting } = require('../../../../settings/settings.service');
const { resolveConnection } = require('../../../../integrations/registry/connections.resolve');
const { buildAdapterCtx } = require('../../../../integrations/registry/adapterCtx');
const { acceptedWebhookSecrets } = require('../../../../integrations/webhooks/webhooks.secret');
const { CHANNEL_META, MODES, releaseKey } = require('../channels');
const { CHANNEL_SETTING_DEFAULTS, SLOW_MS_KEY, RETRY_AFTER_KEY, RELEASED, NOT_RELEASED } = require('../channel.settings');
const { channelNotReleased, normalizeChannel } = require('../channel.errors');
const channelRegistry = require('../registry/channelRegistry');
const { installChannelAdapters } = require('../registry/install');
const { mintReleaseProof } = require('./releaseProof');

/** O canal está liberado para a empresa? (parâmetro `marketing.channel.<canal>.liberado` = ligado; padrão desligado). */
async function isChannelReleased(channel, tenant, transaction) {
  const value = await getSetting(releaseKey(normalizeChannel(channel)), tenant, transaction, NOT_RELEASED);
  return value === RELEASED;
}

async function sandboxOptions(tenant, transaction) {
  const [slowMs, retryAfterS] = await Promise.all([
    getSetting(SLOW_MS_KEY, tenant, transaction, CHANNEL_SETTING_DEFAULTS[SLOW_MS_KEY]),
    getSetting(RETRY_AFTER_KEY, tenant, transaction, CHANNEL_SETTING_DEFAULTS[RETRY_AFTER_KEY]),
  ]);
  return { scope: tenant.companyId, slowMs, retryAfterS };
}

/**
 * O adapter que o Marketing deve usar agora. `mode`: AUTO (padrão: SANDBOX enquanto o canal não está liberado; PRODUCTION depois), SANDBOX (sempre o
 * simulador, para teste) ou PRODUCTION (pede o provedor real: canal não liberado = 409 MKT_CHANNEL_NOT_RELEASED; liberado = a connection ACTIVE da família
 * no bloco B, 404 INTEGRATION_CONNECTION_NOT_FOUND quando não há). Nenhuma chamada a provedor real sai por outro caminho.
 */
async function resolveChannelAdapter(channelName, { tenant, transaction, mode = 'AUTO' } = {}) {
  installChannelAdapters();
  const channel = normalizeChannel(channelName);
  const released = await isChannelReleased(channel, tenant, transaction);
  if (mode === MODES.PRODUCTION && !released) throw channelNotReleased({ channel });
  if (mode === MODES.SANDBOX || (mode === 'AUTO' && !released)) return channelRegistry.get(channel, MODES.SANDBOX).create(await sandboxOptions(tenant, transaction));
  const connection = await resolveConnection({ companyId: tenant.companyId, domain: CHANNEL_META[channel].family }, transaction);
  const ctx = await buildAdapterCtx(connection, tenant, transaction, { adapterHosts: [] });
  const { secrets } = await acceptedWebhookSecrets({ connectionId: connection.id, companyId: tenant.companyId }, transaction);
  return channelRegistry.get(channel, MODES.PRODUCTION).create(ctx, { proof: mintReleaseProof(), webhookSecrets: secrets });
}

module.exports = { isChannelReleased, resolveChannelAdapter };
