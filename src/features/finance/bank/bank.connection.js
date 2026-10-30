'use strict';

const crypto = require('node:crypto');
const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const AppError = require('../../../utils/AppError');
const registry = require('../../integrations/registry/registry.service');
const { transitionConnection } = require('../../integrations/registry/connections.transition');
const { getSetting } = require('../../settings/settings.service');
const { providerCodeOf } = require('./bank.constants');

const notFound = () => AppError.notFound('Nenhuma integração ativa para este recurso: configure em Integrações.', 'INTEGRATION_CONNECTION_NOT_FOUND');

/** Provedor bancário configurado pela empresa (`sandbox` ou `santander`); desconhecido falha fechado. */
async function configuredProviderKey(tenant, transaction) {
  const key = String(await getSetting('finance.payment_provider', tenant, transaction, 'sandbox')).toLowerCase();
  if (!providerCodeOf(key)) throw AppError.badRequest(`Provedor bancário desconhecido: "${key}".`, 'FINANCE_BANK_PROVIDER_UNKNOWN');
  return key;
}

/**
 * Connection do banco da empresa para o provedor configurado (M9-D237). Devolve a connection ACTIVE do ambiente do servidor. Fora de produção o sandbox (sem credencial nem
 * rede) ganha a connection sozinho na primeira vez, para a empresa que já pagava antes do registro continuar pagando; em produção, ou para o Santander, é preciso
 * cadastrá-la em Integrações (o segredo da API e o do webhook migram do cadastro antigo para o cofre, ver bank.secrets): 404 INTEGRATION_CONNECTION_NOT_FOUND.
 */
async function ensureBankConnection(ctx, providerKey, transaction) {
  const providerCode = providerCodeOf(providerKey);
  if (!providerCode) throw AppError.badRequest(`Provedor bancário desconhecido: "${providerKey}".`, 'FINANCE_BANK_PROVIDER_UNKNOWN');
  const environment = registry.getServerEnvironment();
  const ativa = await IntegrationConnection.findOne({ where: { companyId: ctx.companyId, providerCode, environment, status: 'ACTIVE' }, order: [['created_at', 'ASC']], transaction });
  if (ativa) return ativa;
  const existentes = await IntegrationConnection.findAll({ where: { companyId: ctx.companyId, providerCode, environment }, order: [['created_at', 'ASC']], transaction });
  if (environment === 'PRODUCTION' || existentes.some((c) => ['PAUSED', 'AUTH_FAILED'].includes(c.status))) throw notFound();
  const provider = await IntegrationProvider.findByPk(providerCode, { transaction });
  if (!provider || provider.domain !== 'BANK') throw notFound();
  const rascunho = existentes.find((c) => c.status === 'DRAFT');
  if (rascunho) return transitionConnection(rascunho.id, 'ACTIVE', ctx, transaction);
  if (!provider.sandboxAvailable) throw notFound(); // fornecedor real: a empresa cadastra a connection com a credencial
  const sufixo = existentes.length ? ` #${existentes.length + 1}-${crypto.randomBytes(3).toString('hex')}` : '';
  const criada = await registry.createConnection({ providerCode, environment, label: `Financeiro: ${providerCode} (${ctx.companyId.slice(0, 8)})${sufixo}` }, ctx, transaction);
  return transitionConnection(criada.id, 'ACTIVE', ctx, transaction);
}

module.exports = { ensureBankConnection, configuredProviderKey };
