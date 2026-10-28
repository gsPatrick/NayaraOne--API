'use strict';

const { Op } = require('sequelize');
const { IntegrationProvider, IntegrationConnection } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { getSetting } = require('../../settings/settings.service');
const { getServerEnvironment } = require('./registry.helpers');

/**
 * Devolve a connection ACTIVE da empresa para o fornecedor ou domínio. O ambiente é o do servidor:
 * qualquer `environment` vindo do pedido é ignorado.
 */
async function resolveConnection({ companyId, providerCode, domain }, transaction) {
  if (!companyId || (!providerCode && !domain)) {
    throw AppError.badRequest('Informe a empresa e o fornecedor ou o domínio.', 'VALIDATION_ERROR');
  }
  const environment = getServerEnvironment();
  const where = { companyId, environment, status: 'ACTIVE' };
  if (providerCode) where.providerCode = String(providerCode);
  else {
    const providers = await IntegrationProvider.findAll({ where: { domain: String(domain) }, attributes: ['code'], transaction });
    where.providerCode = { [Op.in]: providers.map((x) => x.code) };
  }
  const candidatas = await IntegrationConnection.findAll({ where, order: [['created_at', 'ASC'], ['id', 'ASC']], transaction });
  if (candidatas.length === 0) {
    throw AppError.notFound('Nenhuma integração ativa para este recurso: configure em Integrações.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  }
  if (candidatas.length > 1 && !providerCode) {
    const regra = await getSetting('integration.registry.domain_resolution', { companyId }, transaction, 'error_if_multiple');
    if (regra === 'oldest_active') return candidatas[0];
    if (regra === 'newest_active') return candidatas[candidatas.length - 1];
    throw AppError.conflict('Há mais de uma integração ativa neste domínio: informe o fornecedor ou ajuste a regra de escolha em Configurações.', 'INTEGRATION_CONNECTION_AMBIGUOUS');
  }
  return candidatas[0];
}

module.exports = { resolveConnection };
