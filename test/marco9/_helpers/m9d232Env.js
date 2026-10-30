'use strict';

// Apoio dos testes dos portais (M9-D232 e M9-D233): três portais sandbox ativos, imóvel publicável, entrega do envio pelo worker e leitura dos vínculos. Roda com COMMIT (banco descartável).
const { sequelize, comTenant, carregarTenants, ctxDe, uniqueSuffix } = require('../../integrations/dispatch/dispatchHelpers');
const { registerBuiltInAdapters } = require('../../../src/features/integrations/adapters');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
const { transitionDispatch } = require('../../../src/features/integrations/dispatch');
const { processClaimed } = require('../../../src/features/integrations/dispatch/worker');
const { Group, Company } = require('../../../src/models');
const { criarImovel } = require('./intReadModel');

const PORTAIS = Object.freeze(['portal-zap-sandbox', 'portal-vivareal-sandbox', 'portal-olx-sandbox']);
let tenant;
let grupo;
let empresa;
const carregar = async () => {
  ({ tenant } = await carregarTenants());
  try { registerBuiltInAdapters(); } catch { /* já registrados */ }
  [grupo, empresa] = await comTenant(tenant, async (t) => [await Group.findByPk(tenant.groupId, { transaction: t }), await Company.findByPk(tenant.companyId, { transaction: t })]);
  return tenant;
};

/** Conexão ATIVA do portal (desativa a anterior do mesmo fornecedor). */
async function portalAtivo(providerCode) {
  const c = await comTenant(tenant, (t) => registry.createConnection({ providerCode, environment: registry.getServerEnvironment(), label: `QA-M9 ${providerCode} ${uniqueSuffix()}` }, ctxDe(tenant), t));
  await comTenant(tenant, async (t) => {
    await sequelize.query("UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = :p AND status = 'ACTIVE' AND id <> :id", { replacements: { c: tenant.companyId, p: providerCode, id: c.id }, transaction: t });
    await transitionConnection(c.id, 'ACTIVE', ctxDe(tenant), t);
  });
  return c;
}

/** Desativa todo portal ativo de outros testes e ativa um por fornecedor pedido. Devolve { zap, viva, olx }. */
async function tresPortais(codigos = PORTAIS) {
  await comTenant(tenant, (t) => sequelize.query("UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND status = 'ACTIVE' AND provider_code IN (SELECT code FROM integration.providers WHERE domain = 'PORTAL')", { replacements: { c: tenant.companyId }, transaction: t }));
  const feitos = [];
  for (const code of codigos) feitos.push(await portalAtivo(code)); // eslint-disable-line no-await-in-loop
  return feitos;
}

/** Leva o envio (PENDING ou RETRY_WAIT) até a chamada ao portal, como o worker faz. */
async function entregar(dispatchId) {
  await comTenant(tenant, (t) => transitionDispatch(ctxDe(tenant), dispatchId, 'SENDING', {}, { motivo: 'QA-M9 entrega' }, t));
  return processClaimed(ctxDe(tenant), dispatchId);
}

const ler = (sql, replacements = {}) => comTenant(tenant, async (t) => (await sequelize.query(sql, { replacements: { c: tenant.companyId, ...replacements }, transaction: t }))[0]);
const vinculos = (propertyId) => ler('SELECT l.*, c.provider_code FROM real_estate.portal_listings l JOIN integration.connections c ON c.id = l.connection_id WHERE l.company_id = :c AND l.property_id = :p ORDER BY c.provider_code', { p: propertyId });
const envios = (listingId) => ler("SELECT * FROM integration.dispatches WHERE company_id = :c AND aggregate_type = 'PortalListing' AND aggregate_id = :l ORDER BY created_at", { l: listingId });

module.exports = {
  sequelize, comTenant, ctxDe, uniqueSuffix, criarImovel, carregar, tresPortais, portalAtivo, entregar, ler, vinculos, envios, PORTAIS,
  get tenant() { return tenant; }, get grupo() { return grupo; }, get empresa() { return empresa; },
};
