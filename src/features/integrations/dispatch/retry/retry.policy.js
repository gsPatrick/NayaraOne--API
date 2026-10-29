'use strict';

const { IntegrationConnection, IntegrationProvider } = require('../../../../models');
const { RETRY_LIMITS, RATE_LIMIT_LIMITS } = require('./retry.limits');
const { readRetryParams } = require('./retry.params');

const pick = (obj, limits) => Object.fromEntries(Object.entries(obj && typeof obj === 'object' ? obj : {}).filter(([k, v]) => limits[k] && Number.isInteger(v) && v >= limits[k].min && v <= limits[k].max));

/**
 * Merge da política (M9-D216 seção 5): global (parâmetros da empresa) < `providers.default_policy_json` < `connections.policy_json`.
 * O mais específico vence, campo a campo; valor fora do limite é descartado (a validação ao salvar já o recusou). Devolve
 * { retry: {...todos os campos}, rate_limit: {...só os definidos} } e a origem de cada campo de retry.
 */
function mergePolicies({ global, provider, connection }) {
  const camadas = [['global', global], ['provider', pick(provider && provider.retry, RETRY_LIMITS)], ['connection', pick(connection && connection.retry, RETRY_LIMITS)]];
  const retry = {};
  const origin = {};
  for (const [nome, valores] of camadas) {
    Object.entries(valores).forEach(([k, v]) => { retry[k] = v; origin[k] = nome; });
  }
  const rate = { ...pick(provider && provider.rate_limit, RATE_LIMIT_LIMITS), ...pick(connection && connection.rate_limit, RATE_LIMIT_LIMITS) };
  return { retry, rate_limit: rate, origin };
}

/** Política efetiva de uma connection (lê os parâmetros da empresa, o fornecedor e a connection). */
async function resolveEffectivePolicy(ctx, connection, transaction) {
  const [global, provider] = await Promise.all([readRetryParams(ctx, transaction), IntegrationProvider.findByPk(connection.providerCode, { attributes: ['code', 'defaultPolicyJson'], transaction })]);
  return mergePolicies({ global, provider: provider && provider.defaultPolicyJson, connection: connection.policyJson });
}

/** Idem, a partir do id da connection. */
async function resolveEffectivePolicyById(ctx, connectionId, transaction) {
  const connection = await IntegrationConnection.findOne({ where: { id: connectionId, companyId: ctx.companyId }, transaction });
  return connection ? resolveEffectivePolicy(ctx, connection, transaction) : null;
}

module.exports = { mergePolicies, resolveEffectivePolicy, resolveEffectivePolicyById };
