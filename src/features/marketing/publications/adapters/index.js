'use strict';

/**
 * M9-D430 — adapters de canal do Marketing sobre o framework de Integrações (MKT-011, PRONTO PARA LAB). Fachada da API pública da pasta: o resto do
 * Marketing importa só daqui. Carregar a fachada registra os 9 canais, cada um em SANDBOX e em PRODUCTION.
 */
const channels = require('./channels');
const { ChannelAdapter, OPERATIONS, assertChannelAdapter, capabilitiesForChannel } = require('./ChannelAdapter');
const { SandboxChannelAdapter } = require('./sandbox/SandboxChannelAdapter');
const { RealChannelAdapter } = require('./real/RealChannelAdapter');
const { SCENARIOS } = require('./sandbox/sandbox.scenarios');
const sandboxStore = require('./sandbox/sandbox.store');
const channelRegistry = require('./registry/channelRegistry');
const { installChannelAdapters } = require('./registry/install');
const { mintReleaseProof } = require('./release/releaseProof');
const { isChannelReleased, resolveChannelAdapter } = require('./release/channelAccess');
const { releaseChannel, revokeChannelRelease, channelHomologation, listChannelStatus } = require('./release/releaseChannel');
const { approveConsentPolicy, homologateAdapter, recordChannelDrill } = require('./release/evidence');
const { CONTRACT_CHECKS } = require('./contract/channelContract.checks');
const { runChannelContract } = require('./contract/channelContract.run');
const { planFor, decideOnResult, isQueueExpired } = require('./contingency/channelContingency');
const { fanOut } = require('./contingency/fanOut');
const { sendToChannel } = require('./sendToChannel');
const { verifyAndParseWebhook } = require('./webhook/webhook.parse');
const { publicRouter } = require('./webhook/webhook.routes');
const settings = require('./channel.settings');

installChannelAdapters();

module.exports = {
  ...channels,
  ChannelAdapter,
  OPERATIONS,
  assertChannelAdapter,
  capabilitiesForChannel,
  SandboxChannelAdapter,
  RealChannelAdapter,
  SCENARIOS,
  channelRegistry,
  installChannelAdapters,
  mintReleaseProof,
  isChannelReleased,
  resolveChannelAdapter,
  releaseChannel,
  revokeChannelRelease,
  channelHomologation,
  listChannelStatus,
  approveConsentPolicy,
  homologateAdapter,
  recordChannelDrill,
  CONTRACT_CHECKS,
  runChannelContract,
  planFor,
  decideOnResult,
  isQueueExpired,
  fanOut,
  sendToChannel,
  verifyAndParseWebhook,
  publicRouter,
  resetSandbox: sandboxStore.resetSandbox,
  sandboxRecordCount: sandboxStore.countRecords,
  CHANNEL_SETTINGS_SCHEMA: settings.CHANNEL_SETTINGS_SCHEMA,
  CHANNEL_SETTING_DEFAULTS: settings.CHANNEL_SETTING_DEFAULTS,
};
