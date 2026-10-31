'use strict';

const { registerProvider } = require('../registry');
const { legalContract } = require('./legal.contract');
const { financeEntry } = require('./finance.entry');
const { financePaymentIntent } = require('./finance.paymentIntent');
const { procurementOrder } = require('./procurement.order');
const { property } = require('./property');
const { user } = require('./user');
const { constructionProject } = require('./construction.project');
const { dlpShareLink } = require('./dlp.shareLink');
const { apiClientRevoke, apiClientCreate } = require('./apiClient');
const { integrationRetry, integrationConnection } = require('./integration');
const { aiAgent } = require('./ai.agent');
const { mergeProvider, bulkProvider } = require('../../../features/core-governance/data-quality/confirmation.providers');
const { retentionApplyProvider } = require('../../../features/core-governance/data-quality/retention.impact');
const { legalHoldReleaseProvider } = require('../../../features/core-governance/data-quality/legalHold.impact');
const { activateProvider, restoreProvider } = require('../../../features/core-governance/feature-flags/kill-switch/killSwitch.impact');
const { canaryRollbackProvider } = require('../../../features/migration-v2/canary/canary.impact');

/** Provedores das ações do inventário com rota no código (M9-D852). As linhas sem rota registram o seu provedor na demanda dona. */
const PROVIDERS = {
  'legal.contract.terminate': legalContract,
  'finance.entry.reverse': financeEntry,
  'finance.payment_intent.cancel': financePaymentIntent,
  'procurement.order.cancel': procurementOrder,
  'property.delete': property,
  'user.deactivate': user,
  'construction.project.cancel': constructionProject,
  'dlp.share_link.revoke': dlpShareLink,
  'api_client.revoke': apiClientRevoke,
  'api_client.create': apiClientCreate,
  'integration.error.retry_dangerous': integrationRetry,
  'integration.connection.disable': integrationConnection,
  'ai.agent.deactivate': aiAgent,
  'data_quality.merge': mergeProvider,
  'data_quality.bulk': bulkProvider,
  'retention.apply': retentionApplyProvider,
  'legal_hold.release': legalHoldReleaseProvider,
  'kill_switch.activate': activateProvider,
  'kill_switch.restore': restoreProvider,
  'migration.canary.rollback': canaryRollbackProvider,
};
for (const [key, fn] of Object.entries(PROVIDERS)) registerProvider(key, fn);

module.exports = { PROVIDER_KEYS: Object.keys(PROVIDERS) };
