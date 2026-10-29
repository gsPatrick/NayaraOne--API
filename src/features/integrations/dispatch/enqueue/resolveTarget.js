'use strict';

const { IntegrationConnection, IntegrationProvider } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { PORTS } = require('../../providers/ports');
const adapterRegistry = require('../../registry/adapterRegistry');
const { resolveConnection } = require('../../registry/connections.resolve');

const notFound = () => AppError.notFound('Nenhuma integração ativa para este recurso: configure em Integrações.', 'INTEGRATION_CONNECTION_NOT_FOUND');
const unsupported = () => AppError.unprocessable('O fornecedor não suporta esta operação.', 'INTEGRATION_CAPABILITY_UNSUPPORTED');

/** O port e a definição da operação (schema, mapper, classe de risco e confirmação) de um fornecedor. */
async function portOperation(providerCode, operation, transaction) {
  const provider = await IntegrationProvider.findByPk(providerCode, { transaction });
  const Port = provider && PORTS[provider.domain];
  const def = Port && Port.operations[operation];
  return { provider, Port, def: def || null };
}

/** Capabilities vigentes: as do adapter instalado (quando há) e as do catálogo; a operação precisa estar nas duas. */
function supportsOperation(provider, operation) {
  const catalogo = Array.isArray(provider.capabilities) ? provider.capabilities : [];
  if (!catalogo.includes(operation)) return false;
  const instalado = adapterRegistry.list().find((a) => a.providerCode === provider.code);
  return !instalado || instalado.capabilities.includes(operation);
}

/**
 * resolveTarget — a connection ACTIVE da empresa (por id ou por domínio), o fornecedor e a operação do port. Sem connection ativa:
 * 404 INTEGRATION_CONNECTION_NOT_FOUND (e contingência da família, M9-D226). Operação fora das capabilities: 422.
 */
async function resolveTarget({ companyId, connectionId, domain, operation }, transaction) {
  const connection = connectionId
    ? await IntegrationConnection.findOne({ where: { id: connectionId, companyId, status: 'ACTIVE' }, transaction })
    : await resolveConnection({ companyId, domain }, transaction);
  if (!connection) throw notFound();
  const { provider, def } = await portOperation(connection.providerCode, operation, transaction);
  if (!provider || !def || !supportsOperation(provider, operation)) throw unsupported();
  return { connection, provider, def };
}

module.exports = { resolveTarget, portOperation, supportsOperation };
