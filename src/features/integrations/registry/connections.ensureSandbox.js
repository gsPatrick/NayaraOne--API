'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const AppError = require('../../../utils/AppError');
const registry = require('./registry.service');
const { transitionConnection } = require('./connections.transition');
const { getServerEnvironment } = require('./registry.helpers');

const notFound = () => AppError.notFound('Nenhuma integração ativa para este recurso: configure em Integrações.', 'INTEGRATION_CONNECTION_NOT_FOUND');

/** A connection ACTIVE do ambiente do servidor para um fornecedor, a mais antiga; null quando não há. */
function findActiveByProvider(ctx, providerCode, transaction) {
  return IntegrationConnection.findOne({
    where: { companyId: ctx.companyId, providerCode, environment: getServerEnvironment(), status: 'ACTIVE' }, order: [['created_at', 'ASC'], ['id', 'ASC']], transaction,
  });
}

/** A primeira connection ACTIVE do ambiente do servidor entre os fornecedores de uma família do catálogo; null quando não há. */
async function findActiveByDomain(ctx, domain, transaction) {
  const providers = await IntegrationProvider.findAll({ where: { domain }, attributes: ['code'], transaction });
  return IntegrationConnection.findOne({
    where: { companyId: ctx.companyId, environment: getServerEnvironment(), status: 'ACTIVE', providerCode: { [Op.in]: providers.map((p) => p.code) } },
    order: [['created_at', 'ASC'], ['id', 'ASC']], transaction,
  });
}

/**
 * Connection do fornecedor de laboratório (sandbox, sem credencial nem rede) da empresa (M9-D234, M9-D238 e M9-D241). Fora de produção, a empresa que ainda não
 * cadastrou a integração ganha a connection sozinha na primeira vez, para o módulo de negócio continuar funcionando; em produção, ou com a integração parada de propósito
 * (pausada ou com credencial recusada), é preciso cuidar dela em Integrações: 404 INTEGRATION_CONNECTION_NOT_FOUND. Rascunho do mesmo fornecedor é reaproveitado.
 */
async function ensureSandboxConnection(ctx, { providerCode, label }, transaction) {
  const ativa = await findActiveByProvider(ctx, providerCode, transaction);
  if (ativa) return ativa;
  const environment = getServerEnvironment();
  const existentes = await IntegrationConnection.findAll({ where: { companyId: ctx.companyId, providerCode, environment }, order: [['created_at', 'ASC']], transaction });
  if (environment === 'PRODUCTION' || existentes.some((c) => ['PAUSED', 'AUTH_FAILED'].includes(c.status))) throw notFound();
  const provider = await IntegrationProvider.findByPk(providerCode, { transaction });
  if (!provider || provider.sandboxAvailable !== true) throw notFound();
  const rascunho = existentes.find((c) => c.status === 'DRAFT');
  if (rascunho) return transitionConnection(rascunho.id, 'ACTIVE', ctx, transaction);
  const sufixo = existentes.length ? ` #${existentes.length + 1}-${crypto.randomBytes(3).toString('hex')}` : '';
  const criada = await registry.createConnection({ providerCode, environment, label: `${label} (${ctx.companyId.slice(0, 8)})${sufixo}` }, ctx, transaction);
  return transitionConnection(criada.id, 'ACTIVE', ctx, transaction);
}

module.exports = { ensureSandboxConnection, findActiveByProvider, findActiveByDomain };
