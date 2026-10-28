'use strict';

/** Listagem do catálogo para a administração (Marco 9, M9-D201): `GET /v1/admin/integrations`. */
const { IntegrationProvider, IntegrationConnection } = require('../../../models');
const { getSetting } = require('../../settings/settings.service');
const { getServerEnvironment } = require('../registry/registry.helpers');
const { DOMAINS, DOMAIN_CAPABILITIES, DOMAIN_LABELS, DEFAULT_CRITICALITY } = require('./catalog.domains');
const { CRITICALITY_VALUES, criticalityKey } = require('./catalog.settings');
const { hasContingencyHandler } = require('./contingency.registry');

/** Criticidade vigente da família para a empresa: a configurada pelo administrador; inválida ou ausente cai no padrão. */
async function effectiveCriticality(domain, ctx, transaction) {
  const configurada = await getSetting(criticalityKey(domain), ctx, transaction, null);
  return CRITICALITY_VALUES.includes(configurada) ? configurada : DEFAULT_CRITICALITY[domain];
}

const paraProvider = (p) => ({
  code: p.code, displayName: p.displayName, status: p.status, sandboxAvailable: p.sandboxAvailable,
  capabilities: p.capabilities, supportedVersions: p.supportedVersions, criticality: p.criticality,
});

async function listCatalog(ctx, transaction) {
  const providers = await IntegrationProvider.findAll({ order: [['code', 'ASC']], transaction });
  const ativas = await IntegrationConnection.findAll({
    where: { companyId: ctx.companyId, environment: getServerEnvironment(), status: 'ACTIVE' }, attributes: ['providerCode'], transaction,
  });
  const dominioDe = new Map(providers.map((p) => [p.code, p.domain]));
  const domains = [];
  for (const domain of DOMAINS) {
    const criticality = await effectiveCriticality(domain, ctx, transaction);
    domains.push({
      domain,
      label: DOMAIN_LABELS[domain],
      criticality,
      defaultCriticality: DEFAULT_CRITICALITY[domain],
      capabilities: [...DOMAIN_CAPABILITIES[domain]],
      contingencyRequired: criticality === 'CRITICAL',
      contingencyConfigured: hasContingencyHandler(domain),
      activeConnections: ativas.filter((c) => dominioDe.get(c.providerCode) === domain).length,
      providers: providers.filter((p) => p.domain === domain).map(paraProvider),
    });
  }
  return { environment: getServerEnvironment(), domains };
}

module.exports = { listCatalog, effectiveCriticality };
