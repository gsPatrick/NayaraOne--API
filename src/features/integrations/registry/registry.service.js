'use strict';

/**
 * Registro de integração (Marco 9, M9-D200): fachada que reexporta a API pública.
 * `integration.providers` diz QUAIS fornecedores existem; `integration.connections` diz COMO cada
 * empresa liga cada um em cada ambiente. Nenhum segredo entra aqui: só `secret_ref` (M9-D202).
 *
 * Responsabilidades: registry.constants (listas e transições), registry.helpers (contexto, ambiente,
 * texto), registry.segredo (recusa de segredo), registry.auditoria (serialização, auditoria, MFA),
 * providers.service (catálogo), connections.service (CRUD), connections.transition (status),
 * connections.resolve (escolha da ativa), connections.legacy (migração de contas legadas).
 */
const constants = require('./registry.constants');
const { getServerEnvironment } = require('./registry.helpers');
const { serializeConnection } = require('./registry.auditoria');
const { listProviders, createProvider, updateProvider } = require('./providers.service');
const { createConnection, getConnection, listConnections, updateConnection } = require('./connections.service');
const { transitionConnection } = require('./connections.transition');
const { resolveConnection } = require('./connections.resolve');
const { migrateLegacyProviderAccounts } = require('./connections.legacy');

module.exports = {
  DOMAINS: constants.DOMAINS,
  CRITICALITIES: constants.CRITICALITIES,
  PROVIDER_STATUSES: constants.PROVIDER_STATUSES,
  ENVIRONMENTS: constants.ENVIRONMENTS,
  STATUSES: constants.STATUSES,
  TRANSITIONS: constants.TRANSITIONS,
  getServerEnvironment, serializeConnection,
  listProviders, createProvider, updateProvider,
  createConnection, getConnection, listConnections, updateConnection, transitionConnection,
  resolveConnection, migrateLegacyProviderAccounts,
};
