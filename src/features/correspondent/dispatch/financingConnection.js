'use strict';

const crypto = require('node:crypto');
const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const AppError = require('../../../utils/AppError');
const registry = require('../../integrations/registry/registry.service');
const { transitionConnection } = require('../../integrations/registry/connections.transition');
const { catalogLegacy: { toCatalogCode } } = require('../../integrations');

const notFound = () => AppError.notFound('Nenhuma integração ativa para este recurso: configure em Integrações.', 'INTEGRATION_CONNECTION_NOT_FOUND');

/**
 * Connection de financiamento da empresa para o provider do Correspondente (M9-D240). O Correspondente fala "sandbox" e "manual"; o catálogo, `financing-sandbox`
 * e `financing-manual`. Devolve a connection ACTIVE do ambiente do servidor. Em ambiente que não é produção, o sandbox e o fluxo manual (que não têm
 * credencial nem fornecedor externo) ganham a connection sozinhos na primeira vez, para a empresa que usava o Correspondente antes do registro continuar
 * funcionando; em produção, ou para qualquer outro fornecedor, é preciso cadastrá-la em Integrações: 404 INTEGRATION_CONNECTION_NOT_FOUND.
 */
async function ensureFinancingConnection(ctx, correspondentCode, transaction) {
  const providerCode = toCatalogCode(correspondentCode);
  const environment = registry.getServerEnvironment();
  const ativa = await IntegrationConnection.findOne({ where: { companyId: ctx.companyId, providerCode, environment, status: 'ACTIVE' }, order: [['created_at', 'ASC']], transaction });
  if (ativa) return ativa;
  // Integração parada de propósito (pausada ou com credencial recusada) não ganha uma irmã automática: a pessoa decide em Integrações.
  const existentes = await IntegrationConnection.findAll({ where: { companyId: ctx.companyId, providerCode, environment }, order: [['created_at', 'ASC']], transaction });
  if (environment === 'PRODUCTION' || existentes.some((c) => ['PAUSED', 'AUTH_FAILED'].includes(c.status))) throw notFound();
  const provider = await IntegrationProvider.findByPk(providerCode, { transaction });
  if (!provider || provider.domain !== 'FINANCING' || !(provider.sandboxAvailable === true || providerCode === 'financing-manual')) throw notFound();
  // Rascunho do mesmo fornecedor é reaproveitado (DI-D240-1); desativada (DISABLED é final) não bloqueia: nasce outra, com rótulo que não colide.
  const rascunho = existentes.find((c) => c.status === 'DRAFT');
  if (rascunho) return transitionConnection(rascunho.id, 'ACTIVE', ctx, transaction);
  const sufixo = existentes.length ? ` #${existentes.length + 1}-${crypto.randomBytes(3).toString('hex')}` : '';
  const criada = await registry.createConnection({ providerCode, environment, label: `Correspondente: ${providerCode} (${ctx.companyId.slice(0, 8)})${sufixo}` }, ctx, transaction);
  return transitionConnection(criada.id, 'ACTIVE', ctx, transaction);
}

module.exports = { ensureFinancingConnection };
